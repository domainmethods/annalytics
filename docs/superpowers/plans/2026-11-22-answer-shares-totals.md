# Answer Shares & Totals (Phase 2 + v1.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a verified **Share** column, a **Total** row, and the leader's share in the lead-in to Slack table answers, only when code can prove the denominator. v1.1 widens the proof to `COUNT(DISTINCT dbt-unique-key)` and many-to-one `LEFT JOIN`s.

**Architecture:** A pure verifier, `src/execution/composition.ts`, proves eligibility from three inputs: the executed SQL's node-sql-parser AST, the BigQuery result schema, and the rows. It returns a verdict, and exact BigInt arithmetic in `src/execution/shares.ts` produces the shares. The verifier gets dbt `unique` facts as a plain `uniqueKeys: string[]` argument, so `execution/` never imports `dbt/`. Block builders render a verdict when they're given one. The pipeline and the Table/Summary-fallback overrides compute the verdict behind `ANSWER_SHARES_ENABLED`.

**Tech Stack:** TypeScript, node-sql-parser 5.4 (`{ database: 'BigQuery' }`), Slack Block Kit native `table`, vitest.

**Spec:** `docs/answer-shares-totals-design.md`. Sections cited as §n.

## Global Constraints

- **A wrong percentage is worse than none.** Any unproven case silently renders Phase 1 output, byte-identical.
- No LLM prompt change (Guardrail #5). The Summary override's LLM text, the CSV export, and WhatsApp never get shares.
- 👍/👎, "Change assumptions", Show SQL, and the "Showing X of Y rows" note all stay.
- `execution/` imports nothing from `dbt/`, `agents/`, `slack/`, or `state/`. `validation/` is untouched.
- Firestore rejects `undefined`: omit optional ResponseContext fields when they're absent or empty.
- `ANSWER_SHARES_ENABLED` defaults to `false` until the manual acceptance slice (§7.2) is recorded.
- Labels: `0%` when value = 0; `100%` when value = total; `<1%` when 0 < share < 0.5%; `>99%` when 99.5% ≤ share < 100%; otherwise integer percent, rounded half-up. No largest-remainder adjustment.
- The Share header is the literal `Share`. The Total row reads `Total | <exact total> | 100%`.
- Telemetry `answer.composition` logs `eligible`, `reason`, and `measureKind`, never data values.
- The repo is public: no project IDs, client tables, or evidence data in tests or docs. Use `proj.ds.tbl`-style fixtures.

**Deliberate deviations from the spec** (record them in the governance entry):
- FLOAT64 measures use the same exact-decimal path as NUMERIC: `String(n)`, rejecting exponent forms. The spec's float `number` sum isn't used. The total then equals the sum of the displayed cells exactly.
- v1.1 ships now at the user's request (2026-11-22), not gated on telemetry.
- The verdict carries `usedUniqueKeys`. Only the keys a proof actually relied on are persisted as `compositionUniqueKeys`.

## Review Focus

1. **A CTE that shadows a base-table name** (`WITH t AS (… LIMIT 5) SELECT … FROM t`): the CTE must win resolution and be rejected (`row_source`), and `uniqueKeys` must never match a CTE name. → Task 3 / Task 5 tests.
2. **The measure in column 1, the dimension in column 2**: the Share column is still appended last, and `Total` lands in the dimension's column, not column 0. → Task 6 test.
3. **A NULL dimension group** (a real partition member): it stays eligible, renders `—`, and the lead-in stays rank-only or silent, never crashing. → Task 3 + Task 6 tests.
4. **A legacy ResponseContext without `compositionUniqueKeys`** re-rendering a `COUNT(DISTINCT)` answer: the Table override falls back to rank-only with no throw. → Task 7 test.
5. **Flag off**: the verifier is never called, and the output is byte-identical to Phase 1 for an otherwise eligible result. → Task 7 test.

---

### Task 1: Result column types + shared display cap

**Files:**
- Modify: `src/types.ts` (`QueryResult`), `src/execution/runner.ts`, `src/slack/limits.ts`, `src/pipeline.ts` (`buildResponseBlocks` local constant), `src/handlers/responseOverrides.ts` (two local constants)
- Test: `tests/execution/runner.test.ts` (extend)

**Interfaces:**
- Produces: `QueryResult.columnTypes?: string[]`. It is aligned with `columnNames` and holds the BigQuery `type`, plus a `[]` suffix when `mode === 'REPEATED'` (e.g. `'STRING'`, `'INT64'`, `'RECORD[]'`). Produces `MAX_DISPLAY_ROWS = 20` exported from `src/slack/limits.ts`.

- [ ] **Step 1: Write the failing tests** in `tests/execution/runner.test.ts`:
  - `fills columnTypes from the results schema`: schema fields `[{name:'ch',type:'STRING'},{name:'n',type:'INT64'}]`, rows `[{ch:'a',n:1}]`, so `columnTypes` equals `['STRING','INT64']`.
  - `marks REPEATED fields with []`: field `{name:'tags',type:'STRING',mode:'REPEATED'}` gives `['STRING[]']`.
  - `omits columnTypes when schema names do not match columnNames in order` gives `result.columnTypes` `toBeUndefined()` and `'columnTypes' in result === false`.
- [ ] **Step 2:** Run `npx vitest run tests/execution/runner.test.ts`. Expected: the three new tests fail.
- [ ] **Step 3: Implement.** Widen `lastSchemaFields` to `Array<{ name?: string; type?: string; mode?: string }>`. After `columnNames` is computed, add `columnTypes` (via spread) only when `fields.length === columnNames.length`, every `fields[i].name === columnNames[i]`, and every `type` is a non-empty string. Add `export const MAX_DISPLAY_ROWS = 20;` to `limits.ts` and replace the three local `MAX_DISPLAY_ROWS = 20` declarations with the import.
- [ ] **Step 4:** Run `npx vitest run tests/execution tests/handlers tests/pipeline.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(execution): expose result column types; share MAX_DISPLAY_ROWS`.

### Task 2: Exact share arithmetic

**Files:**
- Create: `src/execution/shares.ts`
- Test: `tests/execution/shares.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ShareCell { basisPoints: number; label: string }
  export type SharesResult =
    | { ok: true; total: string; shares: ShareCell[] }
    | { ok: false; reason: 'measure_value' | 'negative_value' | 'zero_total' };
  export function toExactDecimal(val: unknown, type: string): string | null;
  export function computeShares(values: unknown[], type: string): SharesResult;
  ```
  `type` is one of `INT64 | NUMERIC | BIGNUMERIC | FLOAT64`.

- [ ] **Step 1: Write the failing tests:**
  - `toExactDecimal` cases:
    - `198` with INT64 gives `'198'`
    - `'9007199254740993'` with INT64 gives that string
    - `'1.5'` with INT64 gives `null`
    - `1e21` with FLOAT64 gives `null`
    - `0.1` with FLOAT64 gives `'0.1'`
    - a Big-like `{toString:()=>'15.25'}` with NUMERIC gives `'15.25'`
    - `{value:'42'}` with INT64 gives `'42'`
    - `null`, `NaN`, `Infinity`, `[9]`, `'abc'` and `true` all give `null`
  - `computeShares` cases:
    - A1: `[198,120,42]` gives total `'360'` and labels `['55%','33%','12%']`, with basisPoints `[5500,3333,1167]`
    - A7: `[249,1]` gives `['>99%','<1%']`
    - A8: `[1,1,1]` gives `['33%','33%','33%']`
    - A9: `['9007199254740993','1']` gives total `'9007199254740994'`
    - `[0,5]` gives `['0%','100%']`
    - half-up: `[1,7]` gives `13%` for 12.5%
    - the `<1%` boundary: value/total exactly 0.5% gives `'1%'`, not `<1%`
    - the `>99%` boundary: exactly 99.5% gives `'>99%'`
    - mixed scales: `['1.5','2.25']` gives total `'3.75'`
    - R-24: `[-50,100]` gives `negative_value`
    - R-25: `[0,0]` gives `zero_total`
    - R-26: `[null,1]` gives `measure_value`
- [ ] **Step 2:** Run `npx vitest run tests/execution/shares.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  - Parsing: INT64 accepts a safe-integer `number`, a `/^-?\d+$/` string, or a wrapper via `unwrapBigQueryScalar`. NUMERIC, BIGNUMERIC and FLOAT64 accept a finite `number` whose `String()` matches `/^-?\d+(\.\d+)?$/`, a matching string, or an object whose `String()`/unwrapped value matches.
  - Totals: scale every value to `BigInt` at `scale = max fraction digits` (cap 38, else `measure_value`), then sum.
  - Rounding helper: `roundHalfUp(num: bigint, den: bigint): bigint = (2n*num + den) / (2n*den)` for non-negative inputs.
  - Labels use exact comparisons:
    - `v === 0n` gives `0%`
    - `v === total` gives `100%`
    - `200n*v < total` gives `<1%`
    - `200n*v >= 199n*total` gives `>99%`
    - otherwise `${roundHalfUp(100n*v, total)}%`
  - `basisPoints = Number(roundHalfUp(10000n*v, total))`.
  - Render `total` at the max scale, e.g. `'3.75'`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(execution): exact share arithmetic and labels`.

### Task 3: Composition verifier (v1)

**Files:**
- Create: `src/execution/composition.ts`
- Test: `tests/execution/composition.test.ts`

**Interfaces:**
- Consumes: Task 1 `columnTypes`; Task 2 `computeShares`, `ShareCell`.
- Produces:
  ```ts
  export type CompositionRejectReason =
    | 'result_truncated' | 'row_count' | 'column_count' | 'column_name_collision' | 'column_types'
    | 'total_like_row' | 'parse_failed' | 'outer_shape' | 'group_by_shape' | 'measure_not_additive'
    | 'count_distinct' | 'sum_non_additive_column' | 'limit_applied' | 'row_source' | 'where_subquery'
    | 'where_on_dimension' | 'measure_value' | 'negative_value' | 'zero_total' | 'internal_error';
  export interface CompositionInput { sql: string; result: QueryResult; maxDisplayRows: number; uniqueKeys?: string[] }
  export type EligibleComposition = {
    eligible: true; dimension: string; measure: string; measureKind: 'count' | 'sum';
    total: string; shares: ShareCell[];   // aligned with result.rows
    topIndex: number | null;              // row with the unique max basisPoints; null on a tie
    usedUniqueKeys: string[];             // [] in v1
  };
  export type CompositionVerdict = EligibleComposition | { eligible: false; reason: CompositionRejectReason };
  export function verifyComposition(input: CompositionInput): CompositionVerdict;
  ```

- [ ] **Step 1: Write the failing tests.** One `it` per spec §6 row, each asserting `verdict.eligible` and either `reason` or (for A-rows) `measureKind`, `total` and labels:
  - Eligible rows: A1–A6, A9.
  - Rejected rows: R-1–R-7, R-8 and R-10 (expect `count_distinct` with no `uniqueKeys`), R-11–R-34.
  - For R-34, force the throw with a `result` whose `rows` getter throws.
  - Also cover Review Focus #1 (CTE shadowing) and #3 (a NULL dimension cell is eligible).
  - Add R-35: dimension `LOWER(ch)` grouped by the identical expression is eligible.
  - Add R-36: `SELECT ch, COUNTIF(x) …; SELECT 1` (two statements) gives `parse_failed`.
  - Add R-37: a scalar subquery in the select list gives `measure_not_additive`.
  - Fixtures use `columnTypes` and names like `` `proj.ds.sessions` ``.
- [ ] **Step 2:** Run `npx vitest run tests/execution/composition.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in the check order of §3.3: R1→R5, the collision check right after R3, S0→S8, then V via `computeShares`. Wrap the whole function in `try/catch`, returning `internal_error`. AST facts (probed on 5.4.0):
  - A plain column is `column_ref.column.expr.value`; a qualified one is `column_ref.table` (string) with `column` (string).
  - An ordinal is `{type:'number'}`.
  - Aggregates are `aggr_func` (`COUNT`/`SUM`; `args.distinct === 'DISTINCT'` means count-distinct; `args.expr.type === 'star'`). `COUNTIF`, `ROUND`, `IFNULL`, `COALESCE`, `APPROX_COUNT_DISTINCT` and `ROLLUP` are `function`, with the name at `name.name[0]?.value ?? name.schema.value`.
  - `CAST`/`SAFE_CAST` is `{type:'cast', target:[{dataType}]}`.
  - Set operations are `_next`/`set_op`; HAVING is `having`; QUALIFY is `qualify`; window functions are `over` (check recursively everywhere in a select).
  - FROM items: `join` for a join, `type:'unnest'` for UNNEST, `expr.ast` for a derived table.
  - CTEs are `with[i].name.value` / `with[i].stmt.ast`.
  - LIMIT is `limit.value[0].value`, with `limit.seperator === 'offset'` (or a 2-element value) meaning OFFSET.
  - Subqueries are any node with an `ast` key.
  - TABLESAMPLE fails to parse and gives `parse_failed`.

  Implementation choices:
  - Resolve a FROM name against the CTE list first (CTE shadowing).
  - The S8 dimension reference test collects every `column_ref` name in the outer WHERE and compares it, case-insensitively, against the dimension's source column name and its alias.
  - `measureKind` is `count` for COUNT and COUNTIF, `sum` for SUM.
  - `topIndex` is the unique argmax of basisPoints.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Delete `.probe/`. Commit `feat(execution): composition verifier for share/total eligibility`.

### Task 4: dbt `unique` tests → `TableContext.uniqueColumns`

**Files:**
- Modify: `src/dbt/types.ts`, `src/dbt/parser.ts`
- Test: `tests/dbt/parser.test.ts` (extend)

**Interfaces:**
- Produces: `TableContext.uniqueColumns?: string[]`. These are lower-cased column names; the field is omitted when there are none.

- [ ] **Step 1: Write the failing tests** against a manifest with model `model.pkg.sessions` and test nodes. Cases:
  - `resource_type:'test'`, `test_metadata:{name:'unique',kwargs:{column_name:'session_key'}}`, `attached_node:'model.pkg.sessions'` gives `uniqueColumns` equal to `['session_key']`.
  - A test without `attached_node` but with `depends_on.nodes:['model.pkg.sessions']` (exactly one model) gives the same result.
  - These are all ignored, leaving `uniqueColumns` undefined:
    - `test_metadata.name:'not_null'`
    - `'unique_combination_of_columns'` (namespace `dbt_utils`)
    - `config.where:'x > 1'` (a conditional unique)
    - `config.enabled:false`
    - a test whose `depends_on.nodes` lists two models
  - Duplicate unique tests on one column dedupe to a single entry.
- [ ] **Step 2:** Run `npx vitest run tests/dbt/parser.test.ts`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
  - Do a pre-pass over `manifestNodes` that builds `Map<modelNodeId, Set<string>>` from qualifying tests. Read the column from `column_name ?? test_metadata.kwargs.column_name`. Reject a test whose `test_metadata.namespace` is set and isn't `null`.
  - In the model loop, spread `uniqueColumns` only when the set is non-empty, sorted.
  - Unknown shapes are skipped, never thrown.
- [ ] **Step 4:** Run `npx vitest run tests/dbt && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(dbt): parse unique tests into TableContext.uniqueColumns`.

### Task 5: Verifier v1.1 — `COUNT(DISTINCT unique key)` and many-to-one `LEFT JOIN`

**Files:**
- Modify: `src/execution/composition.ts`
- Test: `tests/execution/composition.test.ts` (extend)

**Interfaces:**
- Consumes: `CompositionInput.uniqueKeys`. Each key is `project.dataset.table.column`, lower-case, matched case-insensitively.
- Produces: `usedUniqueKeys` populated with exactly the keys the proof relied on.

- [ ] **Step 1: Write the failing tests:**
  - U1: `` SELECT ch, COUNT(DISTINCT session_key) n FROM `proj.ds.sessions` GROUP BY ch `` with `uniqueKeys:['proj.ds.sessions.session_key']` gives eligible, kind `count`, and `usedUniqueKeys` equal to that key.
  - U2: the same query without the key gives `count_distinct`.
  - U3: the key on a different table gives `count_distinct`.
  - U4: the key reached through a passthrough CTE (`SELECT *` or the column un-renamed, with a WHERE filter) is eligible. A CTE that renames (`SELECT user_id AS session_key`) gives `count_distinct`. A CTE with GROUP BY gives `row_source`.
  - U5: a 2-part reference `ds.sessions` gives `count_distinct`, because only full 3-part names match.
  - U6: `` FROM `proj.ds.fact` f LEFT JOIN `proj.ds.dim` d ON f.k = d.k GROUP BY d.label `` with `uniqueKeys:['proj.ds.dim.k']` gives eligible, and `usedUniqueKeys` contains `proj.ds.dim.k`.
  - U7: the same with `USING (k)` is eligible.
  - U8: these all give `row_source`:
    - the right key not unique
    - an `INNER JOIN`
    - a `RIGHT`/`FULL` join
    - an ON clause that is `AND`-compound, `<>`, or compares two right-side columns
    - a subquery on the right side
    - a second join whose right key isn't unique
  - U9: `COUNT(DISTINCT f.session_key)` across a valid LEFT JOIN, with both keys unique, is eligible.
  - U10: Review Focus #1 again: a CTE named like a unique-keyed base table never matches the key.
  - R-8, R-9 and R-10 still give `count_distinct` (APPROX is always rejected).
- [ ] **Step 2:** Run the tests. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
  - A base-table reference's full name is the backtick-stripped `table` when it contains two dots, else `[catalog ?? db, schema, table]` when all three exist; otherwise there's no full name.
  - `COUNT(DISTINCT col)` requires a bare `column_ref` that traces through passthrough-only CTEs and derived tables to a base table whose `${fullName}.${col}` is in `uniqueKeys`. With joins present, the column must be qualified by the left (first) source's alias.
  - Joins are allowed only in the outer select. Each `from[i>0]` must have `join` ∈ {`LEFT JOIN`, `LEFT OUTER JOIN`}, be a base table with a full name, and have either `on` as a single `=` between a `column_ref` qualified by this item's alias/name and one qualified by an earlier source, or `using` with exactly one column. The right key must be in `uniqueKeys`.
- [ ] **Step 4:** Run `npx vitest run tests/execution`. Expected: PASS, with all of Task 3 still green.
- [ ] **Step 5:** Commit `feat(execution): accept COUNT(DISTINCT unique) and many-to-one LEFT JOINs`.

### Task 6: Render Share column, Total row, and the leader's share

**Files:**
- Modify: `src/slack/blocks.ts` (`buildTableBlocks`, `buildCodeBlockTable`), `src/slack/answerLeadIn.ts`
- Test: `tests/slack/blocks.test.ts`, `tests/slack/answerLeadIn.test.ts`, `tests/slack/limits.test.ts`

**Interfaces:**
- Consumes: `EligibleComposition` (type-only import from `../execution/composition.js`).
- Produces:
  ```ts
  buildTableBlocks(rows, columnNames, composition?: EligibleComposition): KnownBlock[]
  LeadInInput.leaderShare?: { label: string; rowIndex: number }
  buildAnswerCaptionBlocks(input: LeadInInput & { headline?: string; composition?: EligibleComposition })
  ```
  `buildAnswerCaptionBlocks` derives `leaderShare` from `composition.topIndex` when it isn't null.

- [ ] **Step 1: Write the failing tests:**
  - Blocks:
    - With composition: the header is `[ch, n, 'Share']`, each data row ends with its label, and the last row is `['Total','360','100%']`.
    - Review Focus #2: with columns `[n, ch]`, the last row is `['360','Total','100%']`.
    - A NULL dimension cell renders `—`.
    - A long-text table falls back to the code block and its text still contains `Share` and `Total`.
    - Without composition, the output `toEqual`s the current output (snapshot of the existing fixture).
    - A result already 20 columns wide (`TABLE_COLUMN_LIMIT`) is never given a composition. That's guaranteed by R3, so just assert there's no throw with 2 columns.
  - Lead-in:
    - With the existing `channelRows` fixture (total 250) and `leaderShare:{label:'79%',rowIndex:0}`: `'*Direct* has the highest session count (198, 79% of the total), followed by Unassigned (42).'`
    - With the `shuffled` fixture, `rowIndex` points at Direct's original index (1), so `rowIndex` follows the original row order, not the ranked order.
    - With a `rowIndex` that points at a non-leader row: unchanged Phase 1 text.
    - With the lead-in ineligible (truncated) and a headline: the headline only, with no share added.
- [ ] **Step 2:** Run `npx vitest run tests/slack`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
  - Append the Share column and Total row before the native-limit check, and pass the same augmented header and rows to the code-block fallback. Refactor `buildCodeBlockTable` to take `string[][]` cells.
  - The Total measure cell is `composition.total` as a plain string.
  - In `computeLeadIn`, keep the original row index through the sort. Insert `, <label> of the total` inside the leader's parentheses only when `leaderShare.rowIndex` is the leader's index.
  - Update the doc comment from "never a share or total" to "a share only from a `verifyComposition` proof".
- [ ] **Step 4:** Run `npx vitest run tests/slack && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(slack): render verified Share column, Total row, leader share`.

### Task 7: Flag, pipeline + override wiring, persistence, telemetry, docs

**Files:**
- Modify:
  - `src/config.ts` (`AppConfig.answerShares: { enabled: boolean }`, from `parseEnvBool('ANSWER_SHARES_ENABLED', false)`)
  - `src/pipeline.ts` (`PipelineConfig.answerSharesEnabled?: boolean`, `toPipelineConfig`, Stage 6, `buildResponseBlocks`, `saveResponseContext`)
  - `src/execution/overrideTypes.ts` (`answerSharesEnabled?: boolean`)
  - `src/app.ts` (`overrideConfig`)
  - `src/handlers/responseOverrides.ts` (Table override and Summary fallback)
  - `src/types.ts` (`ResponseContext.compositionUniqueKeys?: string[]`)
  - `.env.example`, `CLAUDE.md` (Response Buttons), `docs/trajectory-governance.md` (Evidence Log)
- Test: `tests/pipeline.test.ts`, `tests/handlers/responseOverrides.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: `verifyComposition` (Task 3/5), the rendering (Task 6), `TableContext.uniqueColumns` (Task 4).
- Produces: `buildResponseBlocks(format, gen, result, traceId, threadTs, statusMsgTs, assumptions?, composition?: EligibleComposition)`.

- [ ] **Step 1: Write the failing tests:**
  - Pipeline, flag on:
    - An eligible `COUNT(*)` result posts a table with a `Share` header and a Total row.
    - The logger gets `{ event:'answer.composition', eligible:true, measureKind:'count' }` and no row values: assert that `JSON.stringify` of the call contains neither `'Direct'` nor `'198'`.
    - A `COUNT(DISTINCT)` answer whose table has `uniqueColumns:['session_key']` persists `compositionUniqueKeys` equal to `['proj.ds.sessions.session_key']`.
    - An ineligible result logs `eligible:false` with `reason` and persists no `compositionUniqueKeys` key.
  - Pipeline, flag off (Review Focus #5): the blocks `toEqual` the Phase 1 output and no `answer.composition` is logged.
  - Overrides:
    - The Table override, with the flag on and `ctx.compositionUniqueKeys`, renders the same Share and Total as the original for the same rows (red-team 5).
    - A legacy ctx without the field and a `COUNT(DISTINCT)` SQL renders rank-only (Review Focus #4).
    - The Summary fallback table carries Share and Total.
    - CSV output contains no `Share`.
    - The Summary LLM path is unchanged.
  - Config: `ANSWER_SHARES_ENABLED` defaults to `false` and parses `true`.
- [ ] **Step 2:** Run `npx vitest run tests/pipeline.test.ts tests/handlers tests/config.test.ts`. Expected: the new tests fail.
- [ ] **Step 3: Implement.**
  - Stage 6: when `config.answerSharesEnabled && format === 'table'`, compute `uniqueKeys = pipelineTables.flatMap(t => (t.uniqueColumns ?? []).map(c => `${t.name}.${c}`.toLowerCase()))`, then call `verifyComposition({ sql, result: queryResult, maxDisplayRows: MAX_DISPLAY_ROWS, uniqueKeys })`. Log it, and pass the verdict to `buildResponseBlocks` only when it's eligible.
  - `buildResponseBlocks` passes `composition` to both the caption and `buildTableBlocks`.
  - Persist `...(verdict?.eligible && verdict.usedUniqueKeys.length ? { compositionUniqueKeys: verdict.usedUniqueKeys } : {})`.
  - Overrides: when `config.answerSharesEnabled`, verify with `uniqueKeys: ctx.compositionUniqueKeys ?? []` and pass the eligible verdict to both builders.
  - Docs:
    - `.env.example`: `ANSWER_SHARES_ENABLED=false`, with a one-line comment on the acceptance gate.
    - CLAUDE.md, Response Buttons: one sentence saying tables get Share/Total only from a `verifyComposition` proof, behind the flag. Add a `response_context` collection-table note for `compositionUniqueKeys`.
    - Governance Evidence Log, dated 2026-11-22, one entry: an answer-presentation change under Guardrails #1/#4; flag default-off pending the §7.2 slice; v1.1 included at the owner's request; the FLOAT64 exact-path deviation; no Deferred Work row touched.
- [ ] **Step 4:** Run `npm run typecheck && npm test`. Expected: all pass.
- [ ] **Step 5:** Commit `feat: wire verified shares/totals behind ANSWER_SHARES_ENABLED`.
