# Phase 3 Features: Chart Generation, BQML Predictions, Benchmark Harness

**Date:** 2026-03-24
**Status:** Historical design, not current next-tranche authority
**Prerequisite:** Strategic analysis in `docs/plans/bqca-strategic-analysis.md`

**Governance checkpoint:** Before implementing work from this design, read `docs/trajectory-governance.md`. As of 2026-06-04, the active next tranche is trust infrastructure: typed `ReferenceCard v1`, benchmark hardening, and teaching validation gates. Broad charts and BQML expansion are deferred unless the governance document is updated with new rationale and evidence.

---

## 1. Overview

Three features to be built natively in Anna Lytics, informed by the BigQuery Conversational Analytics strategic analysis. These fill the capability gaps identified across all four commissioned reports without introducing external service dependencies or dual-system maintenance overhead.

| Feature | Priority | Effort | New Files | Modified Files |
|---|---|---|---|---|
| Chart generation | High | 1 sprint | `src/agents/chartAgent.ts`, `src/execution/chartRenderer.ts` | `pipeline.ts`, `Dockerfile` |
| BQML predictions | Medium | 1 sprint | None | `clarificationAgent.ts`, `agents/types.ts`, `sqlGenerator.ts`, `supervisorAgent.ts`, `pipeline.ts` |
| Benchmark harness | Medium | 1 week | `scripts/benchmark.ts`, `scripts/benchmark-judge.ts`, `scripts/benchmark-analyze.ts`, `benchmarks/corpus.json` | None (standalone tooling) |

---

## 2. Feature 1: Chart Generation

### 2.1 Problem

Anna Lytics returns only text-based responses: tables, summaries, single values, and CSV. Users asking trend, distribution, or comparison questions get tabular data when a chart would communicate the answer more effectively. This is the single biggest UX gap identified in all four strategic reports.

### 2.2 Design

**Fire-and-forget approach:** After the normal response (table/summary) is posted and ResponseContext is saved, the pipeline checks if the result is chartable. If so, it generates a chart and uploads it to the thread. If anything fails, the chart is silently skipped — the user already has the text answer. No existing types, signatures, or code paths are modified.

**Flow:**

```
Query results (from existing execution step)
  → Normal response posted (chat.update) + ResponseContext saved
  → isChartable() checks result shape (standalone utility, not tied to chooseFormat)
  → If chartable: Gemini Flash call with column names, types, sample rows
     → Flash returns vega-lite JSON spec + chart title
  → Validate spec (JSON.parse, check required vega-lite fields: mark, encoding)
  → Render to SVG via vega-lite → convert to PNG via sharp
  → Upload PNG to Slack via filesUploadV2
  → Chart appears below the text answer in the thread
```

**If anything fails** (Flash returns invalid spec, vega-lite render errors, sharp conversion fails, Slack upload fails) → silently skip chart. No error surfaced to user. No state changes.

### 2.3 Chartability Check

Standalone utility function `isChartable()` in `src/execution/chartRenderer.ts`. Not coupled to `chooseFormat()` — no breaking type changes.

A result is chartable when:

- At least 2 columns
- At least 2 rows
- At least one numeric column (for the measure axis)
- At least one non-numeric column or a date/timestamp column (for the dimension axis)

### 2.4 Chart Spec Generation

The LLM call for chart spec generation lives in `src/agents/chartAgent.ts`, following the convention that all LLM interactions go through `agents/`. The rendering logic (vega-lite → SVG → PNG) lives in `src/execution/chartRenderer.ts`. `pipeline.ts` orchestrates: calls `chartAgent.ts` to get the spec, then passes it to `chartRenderer.ts` for rendering.

**Input to Flash:**
- Column names and inferred types (string, number, date)
- First 20 rows of data (enough for Flash to understand shape, not the full result set)
- The original user question (helps Flash pick the right chart type)

**Structured output schema:**
```typescript
interface ChartSpec {
  vegaLiteSpec: Record<string, unknown>;
  chartTitle: string;
  chartType: 'bar' | 'line' | 'scatter' | 'area' | 'pie' | 'heatmap';
}
```

**Prompt instructs Flash to:**
- Pick the most appropriate chart type for the data shape and question
- Use `line` or `area` for time-series data
- Use `bar` for categorical comparisons
- Use `scatter` for two-measure correlations
- Keep specs simple — no layered/faceted charts in v1
- Return the spec with a `data.values` placeholder (Anna injects the actual data)

### 2.5 Rendering Pipeline

1. Inject query result rows into the vega-lite spec's `data.values` (capped at 1,000 rows to prevent OOM/slow renders — full result still available in table format)
2. Compile spec via `vega-lite` → full vega spec
3. Render to SVG via `vega` (pure JS, no DOM/canvas needed)
4. Convert SVG buffer to PNG via `sharp` (pre-built binary for Linux/macOS)
5. PNG dimensions: 800x500px default (readable in Slack)

**Dockerfile change required:** The production image uses `gcr.io/distroless/nodejs20-debian12` which lacks shared libraries that `sharp` needs. Switch the runtime base to `node:20-slim` (has required libs) or evaluate `resvg-js` (pure WASM, no system deps) as an alternative to `sharp` during implementation. The Dockerfile must be tested end-to-end in the chart generation PR.

### 2.6 Slack Integration

**Sequencing:** The text response (`chat.update` with table/summary + buttons) and `saveResponseContext` happen first (existing flow, unchanged). Chart generation runs after — it's a fire-and-forget enhancement.

- Upload PNG via `client.filesUploadV2({ channel_id, thread_ts, file: pngBuffer, filename: 'chart.png' })`
- Slack auto-unfurls uploaded images in the thread — no `image` block needed

### 2.7 New Dependencies

- `vega` — vega-lite compilation target and SVG rendering
- `vega-lite` — declarative chart spec language
- `sharp` — SVG to PNG conversion (pre-built binaries, no Cairo/Pango). **Fallback option:** `resvg-js` (pure WASM) if sharp causes Dockerfile issues with distroless base.

### 2.8 Files Changed

| File | Change |
|---|---|
| `src/agents/chartAgent.ts` | **New.** ~60 LOC. Gemini Flash call for vega-lite spec generation. |
| `src/execution/chartRenderer.ts` | **New.** ~80 LOC. `isChartable()` utility + spec validation + vega render + sharp conversion. |
| `src/pipeline.ts` | Add ~10 LOC after `saveResponseContext`: call `isChartable()` → `generateChartSpec()` → `renderChart()` → `filesUploadV2()` in a try/catch. |
| `Dockerfile` | Switch runtime base from distroless to `node:20-slim` or validate sharp/resvg compatibility. |

**Not changed:** `formatter.ts`, `blocks.ts`, `types.ts`, `responseOverrides.ts`. No breaking type changes. No signature changes. No new state persistence.

### 2.9 Testing

- Unit test `isChartable()` with various column/row combinations
- Unit test `generateChartSpec()` — valid spec, invalid JSON, missing fields
- Unit test `renderChart()` — mock vega-lite and sharp
- Unit test graceful fallback: mock failures at each stage, verify null returned
- Integration test: full pipeline with chartable result, verify chart uploaded after text response

### 2.10 Deferred to v2

- Chart override button (user-triggered charting via button click)
- `chartMetadata` persistence in ResponseContext
- `FormatResult` refactor of `chooseFormat()`

---

## 3. Feature 2: BQML Prediction Functions

### 3.1 Problem

Users asking forecasting or anomaly detection questions ("predict next month's revenue", "find unusual spikes in daily signups") get no answer because the SQL generator doesn't know about BigQuery ML functions. These are SELECT-based functions that flow through the existing pipeline unchanged.

### 3.2 Design

**Flow:**

```
User question with forecast/anomaly/generation intent
  → Clarification classifier detects BQML sub-intent (new field)
  → bqml_hint passed to SQL generator
  → System prompt includes relevant ML.* function signatures + usage examples
  → Generated SQL is a SELECT using ML.FORECAST / ML.DETECT_ANOMALIES / ML.GENERATE
  → Existing validation pipeline handles unchanged (L1-L4 all pass SELECT statements)
  → Supervisor gets BQML-aware review criteria
  → Results are normal tabular data → existing formatting + chart generation applies
```

### 3.3 Scope: Prediction Only

Only SELECT-based prediction functions are in scope:

| Function | Purpose | Returns |
|---|---|---|
| `ML.FORECAST` | Time-series prediction | Tabular: timestamp, forecast_value, confidence intervals |
| `ML.DETECT_ANOMALIES` | Outlier identification | Tabular: row data + is_anomaly boolean + anomaly score |
| `ML.GENERATE_TEXT` | Text generation via remote model | Tabular: input + generated text |

**Explicitly out of scope:**
- `CREATE MODEL` / `CREATE OR REPLACE MODEL` (training DDL)
- `ML.EVALUATE` (model evaluation)
- `ML.WEIGHTS` (model inspection)
- Any model lifecycle management

**Validation behavior:**
- **L1 static analysis: no changes required.** These are all SELECT statements. The existing `CREATE` block continues to block training DDL. L1 strips string literals before pattern matching, so `ML.GENERATE_TEXT` prompts containing blocked keywords (e.g., "DELETE the old records" as a text prompt) will not cause false positives.
- **L2 AST validation: will produce advisory parse errors for ML.* queries.** `node-sql-parser` does not support BigQuery ML function syntax. This is acceptable because L2 is advisory-only — parse failures return `valid: true` with an advisory error message, passing through to L3. The benchmark harness should expect L2 advisory errors (non-empty `error` field) for all BQML queries.
- **L3 dry-run: works normally.** BigQuery's dry-run validates ML.* function syntax natively.
- **L4 cost gate: works normally.** Dry-run returns bytes processed for ML.* queries.

### 3.4 Clarification Classifier Changes

Add optional field to `ClarificationResult`:

```typescript
bqml_hint?: 'forecast' | 'anomaly' | 'generate' | null;
```

Extend the classification prompt to detect BQML-relevant keywords:
- **Forecast**: "forecast", "predict", "projection", "trend forward", "next month/quarter/year"
- **Anomaly**: "anomaly", "anomalies", "outlier", "unusual", "spike", "deviation", "unexpected"
- **Generate**: "summarize text", "generate description", "classify text"

The `bqml_hint` is advisory — it tells the SQL generator which function signatures to include in context. It does not change the pipeline route (still `data_query`).

**Pipeline threading:** The hint must flow from clarification through to generation:
1. `classifyQuestion()` returns `ClarificationResult` with `bqml_hint` (update Zod schema in `clarificationAgent.ts` and interface in `agents/types.ts`)
2. `pipeline.ts` extracts `bqml_hint` from clarification result
3. `qualityLoop()` accepts `bqml_hint` as a new optional parameter on its options
4. `generateSql()` accepts `bqml_hint` on `GenerateSqlOptions` and conditionally includes ML.* signatures in the system prompt

### 3.5 SQL Generator Changes

When `bqml_hint` is non-null, append a BQML section to the system prompt:

**For `forecast`:**
```
BIGQUERY ML FUNCTIONS AVAILABLE:
The user is asking about forecasting/prediction. You may use ML.FORECAST:

SELECT *
FROM ML.FORECAST(
  MODEL `project.dataset.model_name`,
  STRUCT(horizon INT64, confidence_level FLOAT64)
)

Notes:
- The model must already exist (SELECT only, no CREATE MODEL)
- Common models: ARIMA_PLUS for time series
- Returns: forecast_timestamp, forecast_value,
  standard_error, confidence_level,
  prediction_interval_lower_bound, prediction_interval_upper_bound
```

Similar blocks for `anomaly` (`ML.DETECT_ANOMALIES`) and `generate` (`ML.GENERATE_TEXT`).

When `bqml_hint` is null, no BQML context is added (keeps prompt lean for normal queries).

### 3.6 Supervisor Changes

Add one item to the supervisor review checklist:

```
9. If the query uses ML.* functions:
   - Is the function appropriate for the user's question?
   - Are parameters reasonable (e.g., forecast horizon isn't absurdly large)?
   - Is the referenced model likely to exist in the dataset context?
```

### 3.7 Files Changed

| File | Change |
|---|---|
| `src/agents/clarificationAgent.ts` | Add `bqml_hint` to Zod output schema and detection keywords in prompt. ~20 LOC. |
| `src/agents/types.ts` | Add `bqml_hint` field to `ClarificationResult` interface. ~3 LOC. |
| `src/agents/sqlGenerator.ts` | Add `bqml_hint` to `GenerateSqlOptions` (defined here). Add BQML function signatures to system prompt when hint is present. ~45 LOC. |
| `src/agents/supervisorAgent.ts` | Add BQML review criteria to checklist. ~10 LOC. |
| `src/qualityLoop.ts` | No changes needed — `bqml_hint` is on `GenerateSqlOptions` which `qualityLoop` passes through to `generateSql()` automatically. |
| `src/pipeline.ts` | Extract `bqml_hint` from clarification result, pass to quality loop. ~3 LOC. |

### 3.8 Testing

- Unit test clarification classifier returns correct `bqml_hint` for forecast/anomaly/generate keywords
- Unit test clarification returns `null` hint for normal data queries (no false positives)
- Unit test SQL generator includes ML.FORECAST signatures when `bqml_hint: 'forecast'`
- Unit test SQL generator does NOT include BQML context when hint is null
- L1 static analysis test: `SELECT * FROM ML.FORECAST(...)` passes (already should, it's a SELECT)
- L1 static analysis test: `CREATE OR REPLACE MODEL ...` still blocked

---

## 4. Feature 3: Offline Benchmark Harness

### 4.1 Problem

Anna Lytics has no systematic way to measure SQL generation quality, track regressions, or compare against alternatives (including BQ CA when it reaches GA). The teaching store and supervisor loop improve quality, but there's no quantitative feedback loop.

### 4.2 Design

Four standalone scripts + a question corpus. No production code changes.

```
benchmarks/
  corpus.json                    # Question corpus with metadata
  results/
    YYYY-MM-DD.json              # Per-run results
    YYYY-MM-DD-summary.md        # Generated analysis report
scripts/
  benchmark.ts                   # Runner: executes questions through pipeline
  benchmark-judge.ts             # Judge: LLM evaluates results
  benchmark-analyze.ts           # Analyzer: compares runs, detects regressions
  benchmark-expand-corpus.ts     # Corpus expander: pulls from Firestore
```

### 4.3 Question Corpus

`benchmarks/corpus.json` — array of question entries:

```typescript
interface CorpusEntry {
  id: string;                              // Stable identifier
  question: string;                        // Natural language question
  category: 'simple' | 'join' | 'aggregate' | 'time_series' | 'ambiguous' | 'edge_case';
  source: 'manual' | 'production_positive' | 'production_negative' | 'escalation';
  expectedTables?: string[];               // Known-good table references
  knownGoodSql?: string;                   // Reference SQL (if available)
  notes?: string;                          // Context for human reviewers
}
```

**Seed corpus:** ~100 manually curated questions from Slack history, covering:
- Simple lookups (10-15)
- Multi-table joins (10-15)
- Aggregations with GROUP BY (10-15)
- Time-series / date-range queries (10-15)
- Ambiguous questions that required clarification (10-15)
- Edge cases that caused escalations (10-15)
- Questions with known-good reference SQL from resolved escalations (10-15)

**Corpus expansion script** (`scripts/benchmark-expand-corpus.ts`):
- Pulls from Firestore `response_context` collection
- Balanced sampling: equal draws from thumbs-up, thumbs-down, escalated, and high-confidence-pass buckets
- Deduplicates against existing corpus entries (normalized string comparison: lowercase, trim whitespace, strip punctuation; threshold: <10% character difference)
- Outputs candidates to `benchmarks/corpus-candidates.json` for human review before merging

### 4.4 Runner

`scripts/benchmark.ts` — executes questions through Anna's pipeline in isolation:

**Setup:**
- Requires real credentials: `GEMINI_API_KEY` (for SQL generation + supervisor), GCP project with BigQuery access (for dry-run), Firestore access (for teaching/context retrieval)
- Mocks Slack client (no-op callbacks for status updates, no real messages sent)
- Uses real Gemini API — SQL generation and supervisor must use production models for meaningful benchmarks

**Per-question execution:**
- Calls `classifyQuestion()` → captures route and confidence
- Calls `qualityLoop()` → captures generated SQL, validation results, supervisor verdict, retry count
- Does NOT execute queries against BigQuery (dry-run only for cost safety)
- Captures timing for each stage

**Output per question:**
```typescript
interface BenchmarkResult {
  corpusId: string;
  question: string;
  generatedSql: string | null;
  confidence: 'high' | 'medium' | 'low';
  qualityVerdict: 'pass' | 'fail_then_pass' | 'exhausted' | 'cost_exceeded';
  retryCount: number;
  validationResults: { l1: boolean; l2: boolean; l3: boolean; l4: boolean };
  bytesProcessed: number | null;
  supervisorNotes: string;
  teachingCompliance: string;
  latencyMs: { clarification: number; generation: number; validation: number; supervisor: number; total: number };
  groundingCitations: string[];
}
```

**Optional second actor:** When BQ CA Conversations API is available, run the same question through it and capture the returned SQL. Stored alongside Anna's result for comparison.

### 4.5 Judge

`scripts/benchmark-judge.ts` — LLM-as-Judge evaluation:

**Input:** Array of `BenchmarkResult` entries + corresponding `CorpusEntry` metadata.

**Model:** Gemini Pro with structured output.

**Evaluation criteria** (each scored 1-5):

| Criterion | 1 (Poor) | 3 (Acceptable) | 5 (Excellent) |
|---|---|---|---|
| **Correctness** | Wrong tables, wrong logic, doesn't answer question | Mostly correct, minor issues | Precisely answers the question |
| **Efficiency** | Full table scans, unnecessary joins | Reasonable but could optimize | Minimal scan, appropriate indexing hints |
| **Readability** | No aliases, confusing structure | Readable but not clean | Clear aliases, logical structure, well-formatted |
| **Teaching compliance** | Contradicts known patterns | No relevant teaching | Follows established patterns |
| **Safety** | Contains risky patterns | Minor concerns | Clean, no risky patterns |

**Output per question:**
```typescript
interface JudgeResult {
  corpusId: string;
  scores: {
    correctness: number;
    efficiency: number;
    readability: number;
    teachingCompliance: number;
    safety: number;
  };
  overallScore: number;        // Weighted average
  rationale: string;           // Free-text explanation
  suggestedImprovement?: string; // What would make the SQL better
  flaggedForReview: boolean;   // Judge recommends human attention
}
```

**No auto-promotion.** All judge output is written to the results file for human review. Humans decide what becomes a teaching candidate, what needs investigation, and what to ignore.

### 4.6 Analyzer

`scripts/benchmark-analyze.ts` — compares runs and generates reports:

**Input:** Two or more result files from `benchmarks/results/`.

**Output:** Markdown summary (`benchmarks/results/YYYY-MM-DD-summary.md`) containing:
- Overall score distribution (mean, median, p25, p75 per criterion)
- Regression detection: questions where score dropped ≥2 points vs. previous run
- Improvement detection: questions where score increased ≥2 points
- Category breakdown: average scores per question category
- Failure analysis: questions that exhausted retries, grouped by failure type
- If BQ CA results present: side-by-side comparison on all criteria
- Top 10 candidates for teaching review (highest judge scores on previously-failing questions)

### 4.7 Files

| File | Purpose | Approx LOC |
|---|---|---|
| `scripts/benchmark.ts` | Runner | ~200 |
| `scripts/benchmark-judge.ts` | LLM judge | ~150 |
| `scripts/benchmark-analyze.ts` | Report generator | ~150 |
| `scripts/benchmark-expand-corpus.ts` | Corpus auto-expander | ~100 |
| `benchmarks/corpus.json` | Seed question corpus | ~100 entries |

### 4.8 Testing

- Unit test corpus loading and validation (schema check on entries)
- Unit test analyzer regression detection logic with synthetic score data
- Unit test balanced sampling in corpus expander (mock Firestore data)
- Integration test: run 5 corpus entries through full runner → judge → analyze pipeline

---

## 5. Cross-Feature Integration

### Chart + BQML

BQML prediction results (forecast values with confidence intervals, anomaly scores) are normal tabular data. They flow into the chart generation pipeline naturally:
- `ML.FORECAST` results → line chart with confidence band (Flash picks this from the column shape)
- `ML.DETECT_ANOMALIES` results → scatter plot with anomaly points highlighted

No special handling needed — the LLM-generated vega-lite spec adapts to the data shape.

### Benchmark + Chart + BQML

The benchmark harness evaluates SQL quality, not formatting. Chart generation and BQML are orthogonal — the runner captures generated SQL and validation results, which is what the judge scores. Chart rendering is a post-execution concern that doesn't affect benchmark metrics.

However, the corpus should include BQML-intent questions (forecast, anomaly categories) to measure whether the BQML hint pipeline produces valid ML.* SQL.

---

## 6. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Flash generates invalid vega-lite specs | Validate JSON structure before rendering. Fallback to table-only. |
| Sharp fails on Cloud Run (distroless base) | Switch Dockerfile to `node:20-slim` or use `resvg-js` (pure WASM, zero system deps). Must be validated in Docker build before merge. |
| BQML hint false positives (normal query misclassified as forecast) | Hint is advisory only — SQL generator can ignore it if the data doesn't support ML functions. Supervisor catches misuse. |
| BQML models don't exist in target dataset | L3 dry-run catches this (model reference fails validation). Normal retry/escalation flow handles it. |
| Benchmark Gemini API costs | Limit corpus to ~100 questions. Estimate: ~200 Gemini calls per run (generation + judge). Budget ~$5-10 per run. |
| Judge LLM hallucination on scores | Scores are for human review only. No automated action taken on judge output. |

---

## 7. Out of Scope

- Chart interactivity (vega-lite supports it, but Slack doesn't)
- BQML model training (`CREATE MODEL`)
- BQML model evaluation or lifecycle management
- Auto-promotion of benchmark findings to teaching store
- Real-time production metrics collection (benchmark is offline only)
- BQ CA integration (per strategic analysis decision)
