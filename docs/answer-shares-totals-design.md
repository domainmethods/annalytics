# Answer Shares & Totals — Design (Phase 2 of the answer-card cognitive-load work)

**Status:** implemented behind `ANSWER_SHARES_ENABLED` (default off), v1 plus the §8 v1.1 items · **Date:** 2026-11-22 · **Surface:** Slack only
**Note:** a dbt `unique` test is a declaration. `dbt build` materializes a model before its tests run, so a failing test can leave duplicates in place; the acceptance slice (§7.2) must confirm the relied-on unique tests pass before the default flips.
**Depends on:** Phase 1 (deterministic rank-only lead-in above result tables, redundant-button hiding, assumptions-line fix), being implemented in parallel on `t3/simplify-answer-cognitive-load`.

## 1. Intent

The cognitive-load review found that analysts read a grouped result ("sessions by channel") and immediately do mental division to see composition. Phase 1 answers "who is biggest" in words, without percentages. Phase 2 adds the composition: a **Share** column, a **Total** row, and the leader's share in the lead-in. It does this **only when code can prove the denominator is correct**.

The one rule that governs every decision below: **a wrong percentage is worse than no percentage.** A share the bot shows is an assertion that the bot computed. Unlike the SQL, the user cannot audit it through "Show SQL", because the arithmetic happens after the query. So eligibility is a proof, not a guess, and every unproven case falls back silently to Phase 1 (rank-only).

### Goals
- Show shares + total on the common composition shape: one categorical dimension, one additive measure, every group present.
- Keep everything deterministic: no prompt change, no extra BigQuery job, no LLM in the loop.
- Keep the original card, the Table override, and the reasoning/SQL toggles consistent with one another.

### Non-goals (v1)
- Shares for multi-measure tables, two-dimension tables (cross-tabs), or time series.
- Shares over joined, UNNESTed, or windowed row sources.
- A `% of total` that the SQL itself computed (`x / SUM(x) OVER()`): that value is already in the table and isn't ours to re-derive.
- Shares in CSV exports (CSV stays raw query output), the Summary override's LLM text, and WhatsApp (governance-capped).

### Anti-goals (a failure even if it "works")
- Any share on a result the SQL truncated (LIMIT, HAVING, QUALIFY, top-N filter).
- Summing a non-additive measure (distinct counts across overlapping groups, averages, rates, ratios).
- A provenance footer explaining the math on every answer (Guardrail #4; Deferred Work "verbose provenance footers").
- A rendering that differs between the original card and a re-render of the same answer, in a way that changes a number.

## 2. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| **A** | **Static proof from the SQL AST + the job's result schema + the returned rows**, using conservative allow-lists | Fires on fewer answers. It can't prove additivity it has no metadata for. But it's cheap and pure, and false-eligible is near zero by construction | **Chosen** |
| B | Rewrite or augment the executed query to fetch the true population total (`GROUP BY ROLLUP`, or a second `SELECT SUM(m)` without the LIMIT) | Correct totals under LIMIT. But it changes what executes after L1–L4 validation (a new trust boundary and a re-validation), adds bytes and latency, and **still doesn't fix non-additive measures** | Rejected |
| C | Have the generator declare `share_safe` / additivity in its structured output | Covers more shapes. But it changes the prompt (forcing a benchmark re-acceptance, Guardrail #5), and an LLM's claim is not proof | Rejected |
| D | Data-only heuristic: sum any numeric-looking column | Trivial to build. But red-team items 1–3 can't be detected from rows alone | Rejected |

## 3. Eligibility verifier

### 3.1 Where it lives
- **`src/execution/composition.ts`** (new, pure, no I/O): `verifyComposition(input): CompositionVerdict`. It lives in `execution/` next to `formatter.ts`/`chooseFormat`, because it is a result-presentation decision over the executed SQL and its result. It imports `node-sql-parser` directly (as `validation/astValidation.ts` does) and imports nothing from `agents/`, `slack/`, `state/` or `dbt/`.
- **`src/execution/shares.ts`** (new, pure): exact-decimal sum and share arithmetic, rounding and labels.
- It deliberately does **not** live in `validation/`. It never blocks an answer, and `validation/` means "may this SQL run".

### 3.2 Inputs and outputs
```ts
interface CompositionInput {
  sql: string;                        // exactly the SQL that executed
  result: QueryResult;                // with the new optional columnTypes (§4.1)
  maxDisplayRows: number;             // pipeline's MAX_DISPLAY_ROWS (20)
}
type CompositionVerdict =
  | { eligible: true; dimension: string; measure: string;
      measureKind: 'count' | 'sum';
      total: string;                  // exact decimal string
      shares: ShareCell[] }           // aligned with result.rows
  | { eligible: false; reason: CompositionRejectReason };   // stable enum code, for telemetry
interface ShareCell { basisPoints: number; label: string }  // label: '47%' | '<1%' | '>99%' | '0%' | '100%'
```
Any exception inside the verifier (a parse throw, an unexpected AST node, a coercion failure) is caught and returns `{ eligible: false, reason: 'internal_error' }`. It never propagates to the answer.

### 3.3 The checks (all must pass, evaluated in this order; the first failure returns its reason)

**R — result-level (cheap, checked first)**
| # | Check | Reject reason |
|---|---|---|
| R1 | `result.truncated === false` and `result.rows.length === result.totalRows` (runner `maxResultRows` cap) | `result_truncated` |
| R2 | `2 <= rows.length <= maxDisplayRows`. Every share-bearing row is visible, so the Slack display cap (20) never hides part of the denominator | `row_count` |
| R3 | Exactly 2 output columns | `column_count` |
| R4 | `columnTypes` present. Dimension type ∈ {`STRING`, `BOOL`}; measure type ∈ {`INT64`, `NUMERIC`, `BIGNUMERIC`, `FLOAT64`}; neither is `REPEATED`/`RECORD`. **Time and numeric dimensions are rejected** (time series aren't composition; a numeric "dimension" is indistinguishable from an ID) | `column_types` |
| R5 | No dimension value matches `/^\s*(total\|grand total\|all\|overall\|\(all\)\|sum)\s*$/i`. A pre-aggregated total row inside the data would double-count | `total_like_row` |

**S — SQL shape (node-sql-parser, `database: 'BigQuery'`)** — in the R5/S4 regexes, `\|` is markdown-table escaping for regex alternation `|`.
| # | Check | Reject reason |
|---|---|---|
| S0 | The SQL parses to exactly one statement of `type: 'select'`. A parse failure → reject (L2 is advisory; here a parse failure means "can't prove") | `parse_failed` |
| S1 | Outer select: no set operation (`_next`/`set_op`), no `DISTINCT`, no `QUALIFY`, no `HAVING`, no window `over` anywhere in the select list | `outer_shape` |
| S2 | `GROUP BY` has **exactly one** item, and it isn't `ROLLUP`/`CUBE`/`GROUPING SETS`. The item resolves (by ordinal, by alias, or as the identical expression) to the **single non-aggregate** select-list item. Map AST columns to `result.columnNames` **by position**, because BigQuery keeps select-list order. If an alias exists it must equal the result column name | `group_by_shape` |
| S3 | The other select item is the measure: an **allow-listed aggregate**, optionally wrapped by `CAST`/`SAFE_CAST(· AS NUMERIC\|FLOAT64)` or `IFNULL(·, 0)`/`COALESCE(·, 0)`; the scale-reducing `ROUND(·, n)` and `CAST`/`SAFE_CAST(· AS INT64)` only over a count, because over a `SUM` they round each cell before the shares are computed. Allow-list: `COUNT(*)`, `COUNT(expr)` (non-distinct), `COUNTIF(expr)` → kind `count`; `SUM(expr)` → kind `sum`. Everything else is rejected (§3.4) | `measure_not_additive` |
| S4 | `SUM(col)` where the argument is a bare column whose name matches the non-additive lexicon `/(rate\|ratio\|pct\|percent\|share\|avg\|average\|mean\|median\|p\d{2}\|_per_\|users?\|visitors?\|unique)/i` is rejected. This blocks summing pre-computed rates or per-day distinct counts across rows | `sum_non_additive_column` |
| S5 | `LIMIT`/`OFFSET` at the outer level: allowed **only** as a literal `LIMIT n` without `OFFSET` **and** `rows.length < n` (the limit provably didn't bite). Any `OFFSET`, or `rows.length >= n` → reject | `limit_applied` |
| S6 | FROM is **exactly one** source, with no `JOIN` of any kind, no comma join, no `UNNEST`, no `TABLESAMPLE`. The source is a base table, or a CTE/derived table that recursively passes S6 and is **row-preserving**: no `GROUP BY`, `DISTINCT`, `LIMIT`, `QUALIFY`, `HAVING`, set ops or joins, and no window function anywhere | `row_source` |
| S7 | `WHERE` (outer and in every CTE on the chain) contains **no subquery** (`IN (SELECT …)`, `EXISTS`, scalar subquery). This blocks top-N-by-subquery | `where_subquery` |
| S8 | Outer `WHERE` does **not reference the dimension column** (by name or alias, including through a passthrough CTE). "Share of channels I filtered to" would be read as share of everything | `where_on_dimension` |

**V — values (exact arithmetic, §5.1)**
| # | Check | Reject reason |
|---|---|---|
| V1 | Every measure cell coerces to a finite exact decimal (§5.1). A `null` cell → reject (an empty SUM group is ambiguous) | `measure_value` |
| V2 | No negative value (refunds and net figures make shares meaningless) | `negative_value` |
| V3 | Total > 0 | `zero_total` |

### 3.4 Conservatively rejected in v1 (explicit list)
- **`COUNT(DISTINCT x)` / `APPROX_COUNT_DISTINCT` / HLL** — always rejected (`count_distinct`). Additivity requires that each `x` falls in exactly one group. That's provable when `x` is a dbt-declared `unique` key of the single source relation (one row per `x`, no fan-out), but the dbt parser (`src/dbt/parser.ts`) currently drops test nodes. Dimension-scope metadata (session-scoped vs event-scoped) doesn't exist in dbt and would be install-specific. Deferred to v1.1 (§8), gated on telemetry.
- `AVG`, `MIN`, `MAX`, `ANY_VALUE`, percentiles, `STRING_AGG`/`ARRAY_AGG`, any arithmetic over aggregates (`SUM(a)/SUM(b)`, `SAFE_DIVIDE`), window aggregates.
- Joins, including many-to-one label joins (provable later via a dbt `unique` key on the right side; v1.1 candidate).
- Multi-measure and multi-dimension results, time dimensions, numeric dimensions.
- Any SQL that node-sql-parser can't parse, including BigQuery constructs it doesn't model. This fails silent by design. Telemetry tells us how often.

### 3.5 Why `COUNT(*)`/`SUM` on a single row-preserving source is a proof
With one source, no joins, and no row-reducing operator before the outer `GROUP BY`, the groups **partition** the filtered rows of that source, and every group is returned (no LIMIT that bit, no HAVING/QUALIFY). A sum over a partition is the population sum, so `Σ rows = the total the user's WHERE describes`. That's exact for `COUNT(*)`, `COUNT(expr)`, `COUNTIF` and `SUM` of non-negative values. The one residual risk is a `SUM` over a column that is itself non-additive across rows (S4's lexicon is a heuristic deny-list). Even then the displayed total equals the sum of the displayed values, so the card is internally consistent, and that risk already lives in the row values the generator chose.

## 4. Plumbing

### 4.1 Runner → pipeline
- `QueryResult` (`src/types.ts`) gains **`columnTypes?: string[]`**, aligned with `columnNames`: BigQuery `type`, suffixed `[]` when `mode === 'REPEATED'`. It's optional, so existing fixtures and mocks still compile. An absent value means "unknown", and R4 rejects.
- `src/execution/runner.ts` already captures `lastSchemaFields`. Widen it to keep `type`/`mode`, and fill `columnTypes` only when there is one schema field per result column with names matching `columnNames` in order. Otherwise omit it. `QueryResult` is never persisted, so the Firestore undefined rule doesn't apply here, but omit rather than set `undefined` anyway.
- The runner also sets `wrapIntegers`: an unsafe INT64 arrives as a string, a safe one as a number. NUMERIC/BIGNUMERIC arrive as `Big` instances. §5.1 handles all of these.

### 4.2 Pipeline → blocks
- In `src/pipeline.ts` Stage 6, right after `chooseFormat`: when `format` is `table`, compute `const composition = verifyComposition({ sql, result: queryResult, maxDisplayRows: MAX_DISPLAY_ROWS })` and pass it to `buildResponseBlocks` as a new optional parameter. Hoist `MAX_DISPLAY_ROWS` to a shared exported constant (`src/slack/limits.ts`), so the pipeline, the overrides and the verifier all use the same 20.
- Log `logger.info({ traceId, event: 'answer.composition', eligible, reason })` with **no data values**. This feeds the acceptance evidence (§7) and v1.1 prioritization.
- `buildResponseBlocks` passes `composition` to `buildTableBlocks(rows, cols, composition?)` and to the Phase 1 lead-in builder. Rejected or absent → today's (Phase 1) output, byte-identical.

### 4.3 Re-renders — nothing needs persisting in v1
- **Reasoning/SQL toggles** (`src/app.ts`) rebuild from `body.message.blocks` and only swap the actions and panel blocks. The table block, with its Share column and Total row, survives verbatim. No change.
- **Table override** (`handleTableOverride`) re-executes `ctx.generatedSql` (the BigQuery 24h cache), so it has fresh full rows plus the schema. It calls the same `verifyComposition` and passes the verdict to `buildTableBlocks`. The verdict depends only on (SQL, result), both available again, so re-renders are consistent by construction.
- **Summary-override fallback table** does the same. The **CSV** override never adds shares.
- **Legacy ResponseContext records** need no special case. v1 reads nothing new from ResponseContext.
- **v1.1 only:** a COUNT(DISTINCT)-unique proof needs dbt facts that handlers don't have. At that point, persist `compositionUniqueKeys?: string[]` (`project.dataset.table.column`, omitted when empty) on ResponseContext at answer time and feed it to the override's verifier. Legacy records lack the field, so COUNT(DISTINCT) re-renders fall back to rank-only (safe, if inconsistent with the original). v1.1 adds the parity test for that. A re-render keeps only the stored keys the loaded manifest still declares, so a removed unique test turns the re-render rank-only.

## 5. Rendering

### 5.1 Arithmetic (`src/execution/shares.ts`)
- Coerce each measure cell to a decimal string: `number` (finite) → `String`, but reject exponent forms for INT64; string INT64 → as-is (validate `/^-?\d+$/`); `Big`/SDK wrapper → `.toString()` or `unwrapBigQueryScalar`; anything else → reject (V1).
- INT64/NUMERIC/BIGNUMERIC: scale to `BigInt` with `scale = max fractional digits observed` (≤ 38), then sum exactly. FLOAT64: plain `number` sum, rejecting non-finite results. No precision loss on IDs-turned-strings, because those columns never reach here (R4, S3).
- Share in basis points: `bp = round_half_up(value * 10000 / total)`, done in BigInt for the exact types.

### 5.2 Labels and rounding (decision: independent rounding, no largest-remainder)
- `value == 0` → `0%`. `0 < share < 0.5%` → **`<1%`**. `99.5% <= share < 100%` → **`>99%`**. `value == total` → `100%`. Otherwise → integer percent, rounded half-up.
- **No largest-remainder adjustment.** It would display, for some row, a percentage that is not that row's own rounding (47.4% shown as 48%). Each label must be the honest rounding of its own value. The column may visibly sum to 99–101%. The Total row's share reads `100%`, which is the true total.
- The lead-in quotes the **leader's** label only (§5.4), so the same rounding applies everywhere.

### 5.3 Share column and Total row (native table)
- Column order: `dimension | measure | Share`. The header is the literal `Share`. If a result column is already named `Share` (case-insensitive), reject (`column_name_collision`), because a share that reads like the SQL's own is confusing.
- The Total row is appended after the data rows: `Total | <exact total, formatted like other measure cells> | 100%`. Measure formatting goes through the same `formatValue` path; the total string from §5.1 is passed as a plain string.
- Limits (`src/slack/limits.ts`): 3 columns ≤ `TABLE_COLUMN_LIMIT` (20). At most 1 header + 20 rows + 1 total = 22 ≤ `TABLE_ROW_LIMIT` (100). The added characters count toward the existing `TABLE_TEXT_LIMIT` check. If the table overflows, the existing code-block fallback renders **the same 3 columns plus the Total row**. The composition is applied before the fallback decision, never dropped silently by it.
- Eligible results never show the "Showing X of Y rows" note (R1 + R2 guarantee every row is shown).

### 5.4 Lead-in (extends Phase 1)
- Phase 1: "Direct has the most sessions (198), followed by Unassigned (42)."
- Phase 2, when eligible: "Direct has the most sessions (198, **47% of the total**), followed by Unassigned (42)." Only the leader's share is quoted. The rest are in the column, which keeps the sentence short (cognitive-load finding). Wording ownership stays with the Phase 1 builder (`computeLeadIn` / `buildAnswerCaptionBlocks` in `src/slack/answerLeadIn.ts`, whose `LeadInInput` already carries `rows`, `columnNames`, `truncated`, `sql`). Phase 2 adds one optional field, `leaderShareLabel?: string`, and `computeLeadIn` appends `, <label> of the total` only when the field is present **and** its own ranked leader is the same row as the verifier's top-share row (a cross-check: both are deterministic, so disagreement means a bug, and the sentence then stays rank-only). Its doc comment ("never a share or total") is updated to say "only from a `verifyComposition` proof".
- When Phase 1's lead-in is ineligible but composition is eligible (both are deterministic, so this should be rare), the table still gets Share + Total. The LLM headline fallback caption is never edited to add numbers.

## 6. Test plan

Pure-function tests in `tests/execution/composition.test.ts` and `tests/execution/shares.test.ts`. Block tests extend `tests/slack/blocks.test.ts`. Pipeline/override wiring tests use the existing mocked integration harness. Each row below is one case: **SQL**, **rows (dim → measure)**, **types**, **expected**.

| # | SQL (abridged) | Rows / types | Expect |
|---|---|---|---|
| A1 | `SELECT ch, COUNT(*) AS sessions FROM t WHERE d>='…' GROUP BY 1 ORDER BY 2 DESC` | Direct 198, Organic 120, Unassigned 42 · STRING/INT64 | ✅ count; total 360; 55% / 33% / 12% |
| A2 | `SELECT ch, SUM(revenue) FROM t GROUP BY ch` | 3 rows · STRING/NUMERIC (Big) | ✅ sum; exact Big total |
| A3 | `… COUNTIF(is_conv) …` / `COUNT(user_id)` | 3 rows · INT64 | ✅ count |
| A4 | `IFNULL(SUM(x),0)`, `CAST(SUM(x) AS NUMERIC)`; `ROUND`/`CAST(… AS INT64)` only over a count | 3 rows | ✅ (`ROUND(SUM(x))` / `CAST(SUM(x) AS INT64)` reject: rounding each cell first can turn 0.4/0.4/1.4 into 0%/0%/100%) |
| A5 | `… GROUP BY ch ORDER BY n DESC LIMIT 10` | 6 rows | ✅ (limit didn't bite) |
| A6 | `WITH s AS (SELECT * FROM t WHERE d>='…') SELECT ch, COUNT(*) FROM s GROUP BY ch` | 3 rows | ✅ passthrough CTE |
| A7 | 1-of-250 shape | big 249, tiny 1 | ✅ labels `>99%` / `<1%` |
| A8 | Rounding drift | 3 × 1/3 | ✅ 33% ×3, Total 100% (no largest-remainder) |
| A9 | INT64 above 2^53 as string | 2 rows | ✅ exact BigInt total |
| R-1 | `… GROUP BY ch ORDER BY n DESC LIMIT 5` | 5 rows | ❌ `limit_applied` (red-team 1) |
| R-2 | `… LIMIT 5 OFFSET 5` | 3 rows | ❌ `limit_applied` |
| R-3 | `… GROUP BY ch HAVING COUNT(*) > 10` | 3 rows | ❌ `outer_shape` |
| R-4 | `… QUALIFY ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) <= 5` | 5 rows | ❌ `outer_shape` |
| R-5 | `WITH top AS (SELECT … LIMIT 5) SELECT ch, COUNT(*) FROM top GROUP BY ch` | 3 rows | ❌ `row_source` |
| R-6 | `… WHERE page IN (SELECT page FROM … ORDER BY n DESC LIMIT 10) GROUP BY page` | 10 rows | ❌ `where_subquery` |
| R-7 | `SELECT * FROM (SELECT ch, COUNT(*) n FROM t GROUP BY ch) WHERE n > 100` | 3 rows | ❌ `group_by_shape` (outer has no GROUP BY; aggregate filtered via subquery) |
| R-8 | `COUNT(DISTINCT user_pseudo_id)` by channel | 3 rows | ❌ `count_distinct` (red-team 2) |
| R-9 | `COUNT(DISTINCT session_key)` by `page_path` (event-scoped) | 3 rows | ❌ `count_distinct` |
| R-10 | `APPROX_COUNT_DISTINCT(x)` | 3 rows | ❌ `count_distinct` |
| R-11 | `AVG(engagement_time)` / `MAX(x)` | 3 rows | ❌ `measure_not_additive` |
| R-12 | `SUM(conversions)/SUM(sessions) AS rate`, `SAFE_DIVIDE(…)` | 3 rows · FLOAT64 | ❌ `measure_not_additive` |
| R-13 | `SUM(conversion_rate)`, `SUM(daily_users)`, `SUM(pct_new)` | 3 rows | ❌ `sum_non_additive_column` |
| R-14 | `x / SUM(x) OVER () AS pct` (pre-computed share) | 3 cols | ❌ `column_count`/`outer_shape` |
| R-15 | `… GROUP BY ROLLUP(ch)` | rows incl. NULL total | ❌ `group_by_shape` |
| R-16 | `GROUP BY ch, device` | 3 cols | ❌ `column_count` |
| R-17 | `FROM t JOIN dim_channel USING (id)` | 3 rows | ❌ `row_source` |
| R-18 | `FROM events, UNNEST(event_params) ep GROUP BY ep.key` | 3 rows | ❌ `row_source` |
| R-19 | `UNION ALL` of two grouped selects | 4 rows | ❌ `outer_shape` |
| R-20 | `SELECT DISTINCT ch, COUNT(*) OVER (PARTITION BY ch)` | 3 rows | ❌ `outer_shape` |
| R-21 | `SELECT customer_id, SUM(amt) … GROUP BY 1`, `customer_id` INT64 | ID dimension | ❌ `column_types` (red-team 3) |
| R-22 | `DATE_TRUNC(d, MONTH)` dimension | DATE | ❌ `column_types` |
| R-23 | `columnTypes` absent (legacy/mocked runner) | any | ❌ `column_types` |
| R-24 | Net revenue with a negative row | −50 | ❌ `negative_value` |
| R-25 | All zeros | 0,0,0 | ❌ `zero_total` |
| R-26 | NULL measure cell | null | ❌ `measure_value` |
| R-27 | Dimension value `Total` / `All` present | 4 rows | ❌ `total_like_row` |
| R-28 | `WHERE ch IN ('Direct','Organic')` | 2 rows | ❌ `where_on_dimension` |
| R-29 | 1 row | 1 | ❌ `row_count` |
| R-30 | 25 rows, `truncated=false` (display cap, red-team 4) | 25 | ❌ `row_count` |
| R-31 | Runner cap hit (`truncated=true`) | 20 of 5000 | ❌ `result_truncated` |
| R-32 | Unparseable BigQuery SQL (e.g. pipe syntax, `PIVOT`) | — | ❌ `parse_failed` |
| R-33 | Column already named `share` | — | ❌ `column_name_collision` |
| R-34 | Verifier throws internally (forced) | — | ❌ `internal_error`, answer still renders |

**Rendering / wiring tests:** label table (`<1%`, `>99%`, `0%`, `100%`, half-up at 0.5); native-table row/column/char limits including the code-block fallback that carries Share + Total; byte-identical Phase 1 output when ineligible; Table override renders the same Share/Total as the original for the same rows (red-team 5); toggles preserve the Share column; CSV contains no Share column; the telemetry line carries no values.

## 7. Governance check

- **Deferred Work:** touches **no** row. It isn't chart generation, it adds no provenance footer (the Total row is data, not provenance), it isn't WhatsApp, and it isn't an evaluation instrument. Per the Maintenance Protocol ("when in doubt, it counts"), the change set still adds a one-line Evidence Log entry saying it's an answer-presentation change under Guardrails #1/#4, with the acceptance result below.
- **Guardrail #1 (trust before surface area):** justified as an interpretation-trust change. It removes user-side mental arithmetic, and the proof-or-omit rule means it can only add correct numbers.
- **Guardrail #5 (clear manual acceptance criterion):** no prompt or SQL-generation change, so the ReferenceCard acceptance stands, and no benchmark re-run is needed. Ship gate:
  1. The §6 case table is green in CI, including every red-team row.
  2. **Manual acceptance slice:** run the operator-local live corpus (sessions & traffic pilot) through a staging deploy. For **every** answer that renders shares, the operator recomputes each share independently in BigQuery (the generated SQL with any LIMIT removed, wrapped as `SELECT dim, m, m / SUM(m) OVER ()`) and compares. **Criterion: zero mismatched share labels and zero shares on a result the operator judges non-additive or truncated. One failure blocks shipping.** Also record the eligibility rate and the reject-reason histogram from `answer.composition` (informational, not gating). Rounded share labels need not sum to 100% while the Total row shows 100%; that is expected and is not a mismatch, because each label is checked against its own exact share.
  3. Record the slice outcome (counts only, no client data, per the template boundary) in the governance Evidence Log in the same change set that enables the feature.
- **Rollout:** behind `ANSWER_SHARES_ENABLED` (default `false` in the template, documented in `.env.example`) until (2) is recorded. Then flip the default in the same change set as the Evidence Log entry.

## 8. Effort and recommended v1 cut

| Piece | Effort |
|---|---|
| `runner.ts` `columnTypes` + `QueryResult` field | 0.25 d |
| `composition.ts` AST verifier (S0–S8, R1–R5) | 1.5 d |
| `shares.ts` exact arithmetic + labels | 0.5 d |
| `blocks.ts` Share column/Total row + code-block fallback, lead-in hook | 0.5 d |
| Pipeline + Table/Summary-fallback override wiring, flag, telemetry | 0.5 d |
| Tests (§6, ~45 cases + wiring) | 1 d |
| Manual acceptance slice + governance entry | 0.5 d |
| **v1 total** | **≈ 4.75 engineer-days** |

**Recommended v1:** everything above, measure kinds `COUNT(*)`/`COUNT(expr)`/`COUNTIF`/`SUM`, a single row-preserving source, a categorical dimension, ≤ 20 rows, flag-gated.

**v1.1 (only if `answer.composition` telemetry shows `count_distinct` or `row_source` among the top reject reasons on real traffic):**
- Parse dbt `unique` tests in `src/dbt/parser.ts` (`resource_type: 'test'`, `test_metadata.name: 'unique'`, `column_name`, attached model) into `TableContext.uniqueColumns?`.
- Accept `COUNT(DISTINCT x)` when `x` is unique on the single source relation (passthrough-only through CTEs).
- Accept many-to-one `LEFT JOIN`s whose right-side key is dbt-unique.
- Persist `compositionUniqueKeys` for override parity (§4.3). ≈ 2 d.

## 9. Open questions / decisions made (non-interactive run: answered by the designer)

1. **Share column, lead-in percentage, or both?** → Both, asymmetrically: the column + Total row carry the data, the lead-in quotes only the leader's share. *Why:* the cognitive-load goal is one glanceable sentence. Repeating every share in prose re-creates the load.
2. **How to decide COUNT(DISTINCT) additivity?** → Reject in v1. A dbt `unique`-key proof is v1.1, gated on telemetry. Dimension-scope inference is rejected outright (no such dbt metadata, and it would be install-specific). *Why:* the dbt parser drops tests today, and building that before knowing how often it matters is speculative.
3. **Largest-remainder rounding?** → No. Each label is its own honest rounding, and Total shows 100%. *Why:* adjusted labels would misstate individual rows, including the one the lead-in quotes.
4. **Allow outer `LIMIT`?** → Only when `rows.length < n` (provably non-binding). *Why:* generators habitually add safety LIMITs, and an unbitten limit removes no rows.
5. **Display truncation (> 20 rows) with a complete SQL result?** → Reject. *Why:* a Total built from rows the user can't see is unverifiable on the card, and "Showing 20 of 25" next to a 100% total reads as contradictory.
6. **Filtering on the dimension itself (`WHERE ch IN (…)`)?** → Reject. *Why:* "47% of total" would be read as share of all channels.
7. **Where does the verifier live?** → `src/execution/` (presentation over executed SQL), not `validation/` (which gates execution), and not `agents/`. It's dbt-free in v1, so no new cross-module import.
8. **Persist anything to ResponseContext?** → Not in v1. Re-renders re-execute and re-verify, and toggles reuse the posted blocks. v1.1 adds one optional array, with a rank-only fallback for legacy records.
9. **Feature flag?** → Yes, default-off until the manual acceptance slice is recorded. *Why:* Guardrail #5, plus a cheap rollback.
10. **Should the Summary override's LLM text mention shares?** → No. *Why:* that would be a prompt change (Guardrail #5) and an LLM-asserted number.
11. **Total row label when a data value is literally "Total"?** → Reject eligibility (R5) rather than relabel. *Why:* a value like that usually means the data already contains a rollup row, which would double-count.
12. **SUM over rate/user-like columns?** → Deny-lexicon reject (S4), a heuristic layered on the structural proof. *Why:* without per-column additivity metadata, name-based denial is the cheapest guard against the most common error (summing daily distinct users). It may be tightened later with a dbt `meta.additive: false` opt-out.

## 10. Left to the builder
- Exact node-sql-parser AST walking (it represents BigQuery backticked three-part names as `db`/`table` parts; ordinal `GROUP BY 1` arrives as `{type:'number'}`; probed on v5.4.0 against the shapes in §6: LIMIT, HAVING, QUALIFY, CTE, COUNT DISTINCT, UNNEST, and binary aggregates all appear distinctly in the AST).
- The `answer.composition` log field names, following existing `logStage` conventions.
- Whether the Table override shares a helper with `buildResponseBlocks` for the table branch (a small duplication exists today).
