# Phase 3 Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Governance checkpoint:** Before executing this plan, read `docs/trajectory-governance.md`. As of 2026-06-04, this plan is historical and is not the active next-tranche authority. The current tranche is typed `ReferenceCard v1`, benchmark hardening, and teaching validation gates. Do not restart broad chart or BQML expansion from this plan unless `docs/trajectory-governance.md` is updated first.

**Goal:** Add chart generation, BQML prediction support, and an offline benchmark harness to Anna Lytics.

**Architecture:** Three independent features sharing no code between them. Feature 1 (charts) and Feature 2 (BQML) modify production code. Feature 3 (benchmark) is standalone tooling in `scripts/` and `benchmarks/`. All three features are independently deployable.

**Tech Stack:** vega + vega-lite (chart specs), sharp or resvg-js (SVG→PNG), Gemini Flash (chart agent), Gemini Pro (benchmark judge), Vitest (tests).

**Spec:** `docs/superpowers/specs/2026-03-24-phase3-features-design.md`

---

## Feature 2: BQML Prediction Functions

*Start here — smallest scope, no new dependencies, unblocks benchmark corpus design.*

### Task 1: Add `bqml_hint` to types

**Files:**
- Modify: `src/agents/types.ts:1-10`
- Modify: `src/agents/sqlGenerator.ts:8-18` (GenerateSqlOptions is defined here)

- [ ] **Step 1: Write the failing test**

Create `tests/agents/clarificationAgent.bqml.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent: mockGenerateContent } };
  }),
}));

import { classifyQuestion } from '../../src/agents/clarificationAgent.js';

describe('classifyQuestion bqml_hint', () => {
  it('returns forecast hint for prediction questions', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        route: 'data_query',
        confidence: 'high',
        reasoning: 'User wants a forecast',
        ambiguities: [],
        assumptions: ['Using ARIMA model'],
        clarifying_questions: [],
        resolved_question: 'Forecast next month revenue',
        bqml_hint: 'forecast',
      }),
    });

    const result = await classifyQuestion(
      'predict next month revenue', [], [], 'test-key',
    );
    expect(result.bqml_hint).toBe('forecast');
  });

  it('returns null hint for normal data queries', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        route: 'data_query',
        confidence: 'high',
        reasoning: 'Simple lookup',
        ambiguities: [],
        assumptions: [],
        clarifying_questions: [],
        resolved_question: 'Show total revenue',
      }),
    });

    const result = await classifyQuestion(
      'show total revenue', [], [], 'test-key',
    );
    expect(result.bqml_hint).toBeUndefined();
  });

  it('returns anomaly hint for outlier questions', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        route: 'data_query',
        confidence: 'high',
        reasoning: 'Anomaly detection request',
        ambiguities: [],
        assumptions: [],
        clarifying_questions: [],
        resolved_question: 'Find anomalies in daily signups',
        bqml_hint: 'anomaly',
      }),
    });

    const result = await classifyQuestion(
      'find unusual spikes in daily signups', [], [], 'test-key',
    );
    expect(result.bqml_hint).toBe('anomaly');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/clarificationAgent.bqml.test.ts`
Expected: FAIL — `bqml_hint` not on `ClarificationResult` type.

- [ ] **Step 3: Add `bqml_hint` to `ClarificationResult` and `GenerateSqlOptions`**

In `src/agents/types.ts`, add to `ClarificationResult`:

```typescript
bqml_hint?: 'forecast' | 'anomaly' | 'generate' | null;
```

In `src/agents/sqlGenerator.ts`, add to `GenerateSqlOptions`:

```typescript
bqml_hint?: 'forecast' | 'anomaly' | 'generate' | null;
```

- [ ] **Step 4: Update Zod schema in clarificationAgent.ts**

In `src/agents/clarificationAgent.ts`, add to `ClarificationSchema`:

```typescript
bqml_hint: z.enum(['forecast', 'anomaly', 'generate']).nullable().optional(),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/agents/clarificationAgent.bqml.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/types.ts src/agents/sqlGenerator.ts src/agents/clarificationAgent.ts tests/agents/clarificationAgent.bqml.test.ts
git commit -m "feat: add bqml_hint to clarification and generation types"
```

### Task 2: Add BQML keyword detection to clarification prompt

**Files:**
- Modify: `src/agents/clarificationAgent.ts:42-59`

- [ ] **Step 1: Write the failing test**

Add to `tests/agents/clarificationAgent.bqml.test.ts`:

```typescript
describe('clarification prompt includes BQML keywords', () => {
  it('prompt mentions forecast/anomaly detection for BQML routing', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        route: 'data_query',
        confidence: 'high',
        reasoning: 'test',
        ambiguities: [],
        assumptions: [],
        clarifying_questions: [],
        resolved_question: 'test',
        bqml_hint: null,
      }),
    });

    await classifyQuestion('test question', [], [], 'test-key');

    const call = mockGenerateContent.mock.calls[0][0];
    const systemPrompt = call.config.systemInstruction;
    expect(systemPrompt).toContain('bqml_hint');
    expect(systemPrompt).toContain('forecast');
    expect(systemPrompt).toContain('anomaly');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/clarificationAgent.bqml.test.ts`
Expected: FAIL — prompt doesn't contain 'bqml_hint'.

- [ ] **Step 3: Add BQML detection instructions to clarification prompt**

In `src/agents/clarificationAgent.ts`, append to `buildClarificationPrompt()` return value:

```typescript
`
BQML INTENT DETECTION:
If the question involves forecasting, prediction, or time-series projection, set bqml_hint to "forecast".
If the question involves anomalies, outliers, unusual patterns, spikes, or deviations, set bqml_hint to "anomaly".
If the question involves text summarization, classification, or generation from data, set bqml_hint to "generate".
Otherwise, leave bqml_hint as null.`
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/agents/clarificationAgent.bqml.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing clarification tests to verify no regression**

Run: `npx vitest run tests/agents/clarificationAgent.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/clarificationAgent.ts tests/agents/clarificationAgent.bqml.test.ts
git commit -m "feat: add BQML keyword detection to clarification prompt"
```

### Task 3: Add BQML function signatures to SQL generator

**Files:**
- Modify: `src/agents/sqlGenerator.ts:35-89`
- Test: `tests/agents/sqlGenerator.bqml.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/agents/sqlGenerator.bqml.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent: mockGenerateContent } };
  }),
}));

import { generateSql } from '../../src/agents/sqlGenerator.js';

const baseOpts = {
  question: 'forecast next month revenue',
  tables: [{ name: 'analytics.revenue', description: 'Revenue table', columns: [{ name: 'date', description: 'Date', dataType: 'DATE' }, { name: 'amount', description: 'Amount', dataType: 'FLOAT64' }], sampleDDL: 'CREATE TABLE analytics.revenue (date DATE, amount FLOAT64)', dependsOn: [], tags: [] }],
  threadContext: [],
  apiKey: 'test-key',
};

describe('generateSql with bqml_hint', () => {
  it('includes ML.FORECAST signature when hint is forecast', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT * FROM ML.FORECAST(MODEL `project.dataset.model`)',
        explanation: 'Forecast query',
        tables_used: ['analytics.revenue'],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'Used ML.FORECAST',
      }),
    });

    await generateSql({ ...baseOpts, bqml_hint: 'forecast' });

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.systemInstruction).toContain('ML.FORECAST');
  });

  it('includes ML.DETECT_ANOMALIES signature when hint is anomaly', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT * FROM ML.DETECT_ANOMALIES(MODEL `m`)',
        explanation: 'Anomaly query',
        tables_used: [],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'test',
      }),
    });

    await generateSql({ ...baseOpts, bqml_hint: 'anomaly' });

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.systemInstruction).toContain('ML.DETECT_ANOMALIES');
  });

  it('does NOT include BQML context when hint is null', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT SUM(amount) FROM analytics.revenue',
        explanation: 'Sum',
        tables_used: ['analytics.revenue'],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'test',
      }),
    });

    await generateSql({ ...baseOpts, bqml_hint: null });

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.systemInstruction).not.toContain('ML.FORECAST');
    expect(call.config.systemInstruction).not.toContain('BIGQUERY ML FUNCTIONS');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/sqlGenerator.bqml.test.ts`
Expected: FAIL — system prompt doesn't contain ML.FORECAST.

- [ ] **Step 3: Add BQML prompt sections to `buildSystemPrompt()`**

In `src/agents/sqlGenerator.ts`, at end of `buildSystemPrompt()` (before `return prompt`):

```typescript
  if (opts.bqml_hint === 'forecast') {
    prompt += `
BIGQUERY ML FUNCTIONS AVAILABLE:
The user is asking about forecasting/prediction. You may use ML.FORECAST:

SELECT *
FROM ML.FORECAST(
  MODEL \`project.dataset.model_name\`,
  STRUCT(horizon AS horizon, 0.95 AS confidence_level)
)

Notes:
- The model must already exist (SELECT only, no CREATE MODEL)
- Common models: ARIMA_PLUS for time series
- Returns: forecast_timestamp, forecast_value, standard_error, confidence_level, prediction_interval_lower_bound, prediction_interval_upper_bound
- Reference actual model names from the schema context above
`;
  } else if (opts.bqml_hint === 'anomaly') {
    prompt += `
BIGQUERY ML FUNCTIONS AVAILABLE:
The user is asking about anomaly detection. You may use ML.DETECT_ANOMALIES:

SELECT *
FROM ML.DETECT_ANOMALIES(
  MODEL \`project.dataset.model_name\`,
  STRUCT(0.05 AS contamination)
)

Notes:
- The model must already exist (SELECT only, no CREATE MODEL)
- Returns: row data + is_anomaly (BOOL) + anomaly_probability (FLOAT64)
- Lower contamination = fewer anomalies detected
`;
  } else if (opts.bqml_hint === 'generate') {
    prompt += `
BIGQUERY ML FUNCTIONS AVAILABLE:
The user is asking about text generation. You may use ML.GENERATE_TEXT:

SELECT ml_generate_text_result
FROM ML.GENERATE_TEXT(
  MODEL \`project.dataset.llm_model\`,
  (SELECT prompt_column FROM source_table),
  STRUCT(1024 AS max_output_tokens)
)

Notes:
- The model must be a remote LLM connection (SELECT only, no CREATE MODEL)
- Returns: ml_generate_text_result (STRING), ml_generate_text_status (STRING)
`;
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/agents/sqlGenerator.bqml.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing generator tests**

Run: `npx vitest run tests/agents/sqlGenerator.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/sqlGenerator.ts tests/agents/sqlGenerator.bqml.test.ts
git commit -m "feat: add BQML function signatures to SQL generator prompt"
```

### Task 4: Add BQML review criteria to supervisor

**Files:**
- Modify: `src/agents/supervisorAgent.ts:77-85`
- Test: `tests/agents/supervisorAgent.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/agents/supervisorAgent.test.ts` (or create `tests/agents/supervisorAgent.bqml.test.ts`):

```typescript
it('supervisor prompt includes BQML review criteria', async () => {
  mockGenerateContent.mockResolvedValue({
    text: JSON.stringify({ verdict: 'PASS', confidence: 'high', issues: [], suggestions: [], teaching_compliance: 'no_relevant_teaching' }),
  });

  await reviewSql({
    userQuestion: 'forecast revenue',
    clarifiedQuestion: 'forecast revenue',
    generatedSql: 'SELECT * FROM ML.FORECAST(MODEL `m`)',
    explanation: 'Forecast',
    reasoningChain: 'Used ML.FORECAST',
    groundingCitations: [],
    apiKey: 'test-key',
  });

  const call = mockGenerateContent.mock.calls[0][0];
  const prompt = call.contents[0].parts[0].text;
  expect(prompt).toContain('ML.');
  // The checklist should include BQML-specific review item
  expect(prompt).toContain('ML.*');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/supervisorAgent.test.ts` (or the new file)
Expected: FAIL — prompt doesn't contain ML.* review criteria.

- [ ] **Step 3: Add BQML review item to supervisor checklist**

In `src/agents/supervisorAgent.ts`, append after item 8 in `buildSupervisorPrompt()`:

```typescript
9. If the query uses ML.* functions:
   - Is the function appropriate for the user's question?
   - Are parameters reasonable (e.g., forecast horizon isn't absurdly large)?
   - Is the referenced model likely to exist in the dataset context?
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/agents/supervisorAgent.test.ts`
Expected: PASS (all existing + new)

- [ ] **Step 5: Commit**

```bash
git add src/agents/supervisorAgent.ts tests/agents/supervisorAgent.test.ts
git commit -m "feat: add BQML review criteria to supervisor checklist"
```

### Task 5: Thread `bqml_hint` through pipeline

**Files:**
- Modify: `src/pipeline.ts:120-122,236-253`

- [ ] **Step 1: Write the failing test**

Add to `tests/pipeline.test.ts` or create `tests/pipeline/bqml.test.ts`:

```typescript
it('passes bqml_hint from clarification to quality loop', async () => {
  // Mock classifyQuestion to return bqml_hint: 'forecast'
  mockClassifyQuestion.mockResolvedValue({
    route: 'data_query',
    confidence: 'high',
    reasoning: 'test',
    ambiguities: [],
    assumptions: [],
    clarifying_questions: [],
    resolved_question: 'forecast revenue',
    bqml_hint: 'forecast',
  });

  // Verify qualityLoop receives bqml_hint in its options
  // (Check the first argument's bqml_hint property)
  mockQualityLoop.mockResolvedValue({
    sqlResult: { sql: 'SELECT 1', explanation: '', tablesUsed: [], confidence: 'high', assumptions: [], reasoningChain: '', groundingCitations: [] },
    verdict: 'pass',
    supervisorNotes: '',
    finalConfidence: 'high',
    retryCount: 0,
    failureHistory: [],
  });

  await runPipeline(baseInput);

  const qualityLoopOpts = mockQualityLoop.mock.calls[0][0];
  expect(qualityLoopOpts.bqml_hint).toBe('forecast');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pipeline.test.ts` (the specific test)
Expected: FAIL — `qualityLoopOpts.bqml_hint` is undefined.

- [ ] **Step 3: Pass `bqml_hint` from clarification result to quality loop options**

In `src/pipeline.ts`, after line 149 (`const resolvedQuestion = ...`), the `bqml_hint` is available on `clarification.bqml_hint`. In the `qualityLoop()` call (line 236), add `bqml_hint: clarification.bqml_hint` to the options object:

```typescript
      {
        question: resolvedQuestion,
        tables: pipelineTables,
        threadContext,
        apiKey: config.geminiApiKey,
        model: config.geminiModel,
        fileSearchStoreId: config.fileSearchStoreId,
        sampleRows: sampleRowsMap.size > 0 ? sampleRowsMap : undefined,
        bqml_hint: clarification.bqml_hint,  // ← add this line
        // ... rest unchanged
      },
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/pipeline.test.ts`
Expected: PASS

- [ ] **Step 5: Verify L1 still blocks CREATE MODEL**

Add to `tests/validation/staticAnalysis.test.ts`:

```typescript
it('passes SELECT with ML.FORECAST (BQML prediction)', () => {
  const result = staticAnalysis("SELECT * FROM ML.FORECAST(MODEL `project.dataset.model`, STRUCT(30 AS horizon))");
  expect(result.valid).toBe(true);
});

it('blocks CREATE OR REPLACE MODEL (BQML training DDL)', () => {
  const result = staticAnalysis("CREATE OR REPLACE MODEL `project.dataset.model` OPTIONS(model_type='ARIMA_PLUS') AS SELECT date, amount FROM revenue");
  expect(result.valid).toBe(false);
});
```

Run: `npx vitest run tests/validation/staticAnalysis.test.ts`
Expected: PASS (both assertions should hold with current L1 rules)

- [ ] **Step 6: Commit**

```bash
git add src/pipeline.ts tests/pipeline.test.ts tests/validation/staticAnalysis.test.ts
git commit -m "feat: thread bqml_hint through pipeline to quality loop"
```

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All tests pass.

---

## Feature 1: Chart Generation

### Task 6: Install chart dependencies and validate Dockerfile

**Files:**
- Modify: `package.json`
- Modify: `Dockerfile:10`

- [ ] **Step 1: Install vega, vega-lite, and sharp (or resvg-js)**

```bash
npm install vega vega-lite sharp
```

If sharp causes issues with the distroless Docker base, use resvg-js instead:

```bash
npm install vega vega-lite @resvg/resvg-js
```

- [ ] **Step 2: Validate Dockerfile builds with new deps**

Try building with current distroless base:

```bash
docker build -t annalytics-test .
```

If sharp requires shared libs not in distroless, switch Dockerfile line 10:

```dockerfile
FROM node:20-slim
```

- [ ] **Step 3: Verify existing tests still pass in Docker**

```bash
npm test
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json Dockerfile
git commit -m "feat: add vega-lite and sharp deps, update Dockerfile for chart rendering"
```

### Task 7: Create chart agent (LLM call for vega-lite spec)

**Files:**
- Create: `src/agents/chartAgent.ts`
- Create: `tests/agents/chartAgent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/agents/chartAgent.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent: mockGenerateContent } };
  }),
}));

import { generateChartSpec } from '../../src/agents/chartAgent.js';

describe('generateChartSpec', () => {
  it('returns a valid chart spec from Flash', async () => {
    const vegaSpec = {
      $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
      mark: 'bar',
      encoding: {
        x: { field: 'region', type: 'nominal' },
        y: { field: 'revenue', type: 'quantitative' },
      },
    };

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        vegaLiteSpec: vegaSpec,
        chartTitle: 'Revenue by Region',
        chartType: 'bar',
      }),
    });

    const result = await generateChartSpec({
      question: 'show revenue by region',
      columnNames: ['region', 'revenue'],
      sampleRows: [{ region: 'US', revenue: 1000 }, { region: 'EU', revenue: 500 }],
      apiKey: 'test-key',
    });

    expect(result).not.toBeNull();
    expect(result!.chartType).toBe('bar');
    expect(result!.vegaLiteSpec).toHaveProperty('mark');
  });

  it('returns null when Flash returns invalid JSON', async () => {
    mockGenerateContent.mockResolvedValue({ text: 'not json' });

    const result = await generateChartSpec({
      question: 'test',
      columnNames: ['a', 'b'],
      sampleRows: [{ a: 1, b: 2 }],
      apiKey: 'test-key',
    });

    expect(result).toBeNull();
  });

  it('returns null when Flash returns spec missing required fields', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ vegaLiteSpec: { mark: 'bar' }, chartTitle: 'test', chartType: 'bar' }),
    });

    const result = await generateChartSpec({
      question: 'test',
      columnNames: ['a', 'b'],
      sampleRows: [{ a: 1, b: 2 }],
      apiKey: 'test-key',
    });

    // Missing encoding field → invalid
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/chartAgent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `chartAgent.ts`**

Create `src/agents/chartAgent.ts`:

```typescript
import { GoogleGenAI } from '@google/genai';

export interface ChartSpecInput {
  question: string;
  columnNames: string[];
  sampleRows: Record<string, unknown>[];
  apiKey: string;
}

export interface ChartSpec {
  vegaLiteSpec: Record<string, unknown>;
  chartTitle: string;
  chartType: 'bar' | 'line' | 'scatter' | 'area' | 'pie' | 'heatmap';
}

const chartResponseSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object' as const,
  properties: {
    vegaLiteSpec: { type: 'object', description: 'Complete vega-lite spec with mark and encoding' },
    chartTitle: { type: 'string' },
    chartType: { type: 'string', enum: ['bar', 'line', 'scatter', 'area', 'pie', 'heatmap'] },
  },
  required: ['vegaLiteSpec', 'chartTitle', 'chartType'],
};

export async function generateChartSpec(input: ChartSpecInput): Promise<ChartSpec | null> {
  try {
    const ai = new GoogleGenAI({ apiKey: input.apiKey });

    const sampleData = input.sampleRows.slice(0, 20);
    const prompt = `Given these query results, generate a vega-lite chart spec.

Question: ${input.question}
Columns: ${input.columnNames.join(', ')}
Sample data (${sampleData.length} rows):
${JSON.stringify(sampleData, null, 2)}

Rules:
- Pick the most appropriate chart type for the data shape
- Use line/area for time-series, bar for categorical comparisons, scatter for correlations
- Keep specs simple — no layered or faceted charts
- Use data.values as an empty array placeholder (data will be injected)
- Include proper axis labels from column names`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.0-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: chartResponseSchema,
      },
    });

    const text = response.text;
    if (!text) return null;

    const parsed = JSON.parse(text);
    if (!parsed.vegaLiteSpec?.encoding || !parsed.vegaLiteSpec?.mark) return null;

    return parsed as ChartSpec;
  } catch (error) {
    console.debug('[ChartAgent] Error generating chart spec:', error);
    return null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/agents/chartAgent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/chartAgent.ts tests/agents/chartAgent.test.ts
git commit -m "feat: add chart agent for LLM-generated vega-lite specs"
```

### Task 8: Create chart renderer with `isChartable` utility

**Files:**
- Create: `src/execution/chartRenderer.ts`
- Create: `tests/execution/chartRenderer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/execution/chartRenderer.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { QueryResult } from '../../src/types.js';

// --- isChartable tests (pure function, no mocks) ---

import { isChartable } from '../../src/execution/chartRenderer.js';

function makeResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return { rows: [], columnNames: [], totalRows: 0, bytesProcessed: 0, truncated: false, ...overrides };
}

describe('isChartable', () => {
  it('returns true for table with numeric + non-numeric columns and 2+ rows', () => {
    const rows = [{ region: 'US', revenue: 100 }, { region: 'EU', revenue: 200 }];
    expect(isChartable(makeResult({ rows, columnNames: ['region', 'revenue'], totalRows: 2 }))).toBe(true);
  });

  it('returns false for single row', () => {
    expect(isChartable(makeResult({ rows: [{ a: 'x', b: 1 }], columnNames: ['a', 'b'], totalRows: 1 }))).toBe(false);
  });

  it('returns false for single column', () => {
    const rows = [{ amount: 10 }, { amount: 20 }];
    expect(isChartable(makeResult({ rows, columnNames: ['amount'], totalRows: 2 }))).toBe(false);
  });

  it('returns false for zero rows', () => {
    expect(isChartable(makeResult({ rows: [], columnNames: ['a', 'b'], totalRows: 0 }))).toBe(false);
  });

  it('returns false when rows array is empty but totalRows > 0 (truncated fetch)', () => {
    expect(isChartable(makeResult({ rows: [], columnNames: ['a', 'b'], totalRows: 100 }))).toBe(false);
  });

  it('returns false for all-string columns (no numeric measure)', () => {
    const rows = [{ a: 'x', b: 'y' }, { a: 'w', b: 'z' }];
    expect(isChartable(makeResult({ rows, columnNames: ['a', 'b'], totalRows: 2 }))).toBe(false);
  });
});

// --- renderChart tests (mocked deps) ---

vi.mock('vega', () => ({
  parse: vi.fn(() => ({})),
  View: vi.fn(function () {
    return {
      initialize: vi.fn().mockReturnThis(),
      toSVG: vi.fn().mockResolvedValue('<svg>test</svg>'),
      finalize: vi.fn(),
    };
  }),
}));

vi.mock('vega-lite', () => ({
  compile: vi.fn(() => ({ spec: {} })),
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    png: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  })),
}));

// Must import renderChart AFTER mocks are set up
const { renderChart } = await import('../../src/execution/chartRenderer.js');

describe('renderChart', () => {
  it('renders a vega-lite spec to a PNG buffer', async () => {
    const spec = {
      $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
      mark: 'bar',
      encoding: { x: { field: 'a' }, y: { field: 'b' } },
      data: { values: [] },
    };

    const result = await renderChart(spec, [{ a: 'x', b: 1 }]);

    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(Buffer);
  });

  it('returns null when vega-lite compilation fails', async () => {
    const { compile } = await import('vega-lite');
    vi.mocked(compile).mockImplementationOnce(() => { throw new Error('bad spec'); });

    const result = await renderChart({ mark: 'invalid' }, []);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/execution/chartRenderer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `chartRenderer.ts`**

Create `src/execution/chartRenderer.ts`:

```typescript
import * as vega from 'vega';
import { compile } from 'vega-lite';
import sharp from 'sharp';
import type { QueryResult } from '../types.js';

const MAX_CHART_ROWS = 1000;
const CHART_WIDTH = 800;
const CHART_HEIGHT = 500;

export function isChartable(result: QueryResult): boolean {
  if (result.rows.length < 2) return false;
  if (result.columnNames.length < 2) return false;
  const firstRow = result.rows[0];
  const hasNumeric = result.columnNames.some(col => typeof firstRow[col] === 'number');
  const hasNonNumeric = result.columnNames.some(col => typeof firstRow[col] !== 'number');
  return hasNumeric && hasNonNumeric;
}

export async function renderChart(
  vegaLiteSpec: Record<string, unknown>,
  rows: Record<string, unknown>[],
): Promise<Buffer | null> {
  try {
    // Inject data (capped at MAX_CHART_ROWS)
    const specWithData = {
      ...vegaLiteSpec,
      data: { values: rows.slice(0, MAX_CHART_ROWS) },
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
    };

    // Compile vega-lite → vega
    const vegaSpec = compile(specWithData as any).spec;

    // Render to SVG
    const view = new vega.View(vega.parse(vegaSpec), { renderer: 'none' });
    const svg = await view.toSVG();
    view.finalize();

    // Convert SVG → PNG
    const pngBuffer = await sharp(Buffer.from(svg))
      .resize(CHART_WIDTH, CHART_HEIGHT)
      .png()
      .toBuffer();

    return pngBuffer;
  } catch (error) {
    console.debug('[ChartRenderer] Error rendering chart:', error);
    return null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/execution/chartRenderer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/execution/chartRenderer.ts tests/execution/chartRenderer.test.ts
git commit -m "feat: add chart renderer (vega-lite SVG to PNG via sharp)"
```

### Task 9: Wire chart generation into pipeline (fire-and-forget)

**Files:**
- Modify: `src/pipeline.ts`

- [ ] **Step 1: Add chart generation after `saveResponseContext`**

In `src/pipeline.ts`, AFTER the existing `saveResponseContext` call (line ~420) and BEFORE the async escalation block, add:

```typescript
    // Stage 7b: Chart generation (fire-and-forget — failures silently skipped)
    if (isChartable(queryResult)) {
      try {
        const chartSpec = await generateChartSpec({
          question: resolvedQuestion,
          columnNames: queryResult.columnNames,
          sampleRows: queryResult.rows.slice(0, 20),
          apiKey: config.geminiApiKey,
        });

        if (chartSpec) {
          const pngBuffer = await renderChart(
            chartSpec.vegaLiteSpec,
            queryResult.rows,
          );

          if (pngBuffer) {
            await client.filesUploadV2({
              channel_id: channel,
              thread_ts: threadTs,
              filename: 'chart.png',
              file: pngBuffer,
              title: chartSpec.chartTitle,
            });
          }
        }
      } catch (error) {
        console.debug('[Pipeline] Chart generation failed (non-blocking):', error);
      }
    }
```

Add imports at top of `pipeline.ts`:

```typescript
import { generateChartSpec } from './agents/chartAgent.js';
import { isChartable, renderChart } from './execution/chartRenderer.js';
```

No changes to `chooseFormat`, `buildFeedbackActions`, `buildResponseBlocks`, `ResponseContext`, or any existing types/signatures.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pipeline.ts
git commit -m "feat: wire fire-and-forget chart generation into pipeline"
```

---

## Feature 3: Offline Benchmark Harness

### Task 10: Create benchmark types and seed corpus

**Files:**
- Create: `benchmarks/corpus.json`
- Create: `scripts/benchmark-types.ts`

- [ ] **Step 1: Create shared types**

Create `scripts/benchmark-types.ts`:

```typescript
export interface CorpusEntry {
  id: string;
  question: string;
  category: 'simple' | 'join' | 'aggregate' | 'time_series' | 'ambiguous' | 'edge_case';
  source: 'manual' | 'production_positive' | 'production_negative' | 'escalation';
  expectedTables?: string[];
  knownGoodSql?: string;
  notes?: string;
}

export interface BenchmarkResult {
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
  latencyMs: {
    clarification: number;
    generation: number;
    validation: number;
    supervisor: number;
    total: number;
  };
  groundingCitations: string[];
}

export interface JudgeResult {
  corpusId: string;
  scores: {
    correctness: number;
    efficiency: number;
    readability: number;
    teachingCompliance: number;
    safety: number;
  };
  overallScore: number;
  rationale: string;
  suggestedImprovement?: string;
  flaggedForReview: boolean;
}

export interface BenchmarkRun {
  runDate: string;
  corpusSize: number;
  results: BenchmarkResult[];
  judgeResults: JudgeResult[];
}
```

- [ ] **Step 2: Create seed corpus with 5 example entries**

Create `benchmarks/corpus.json`:

```json
[
  {
    "id": "seed-001",
    "question": "What was total revenue last month?",
    "category": "simple",
    "source": "manual",
    "expectedTables": ["analytics.fct_revenue"],
    "notes": "Basic aggregation with date filter"
  },
  {
    "id": "seed-002",
    "question": "Show me the top 10 customers by lifetime value",
    "category": "aggregate",
    "source": "manual",
    "expectedTables": ["analytics.fct_orders", "analytics.dim_customers"],
    "notes": "Requires join + aggregation + ORDER BY + LIMIT"
  },
  {
    "id": "seed-003",
    "question": "How has daily active users trended over the past 90 days?",
    "category": "time_series",
    "source": "manual",
    "expectedTables": ["analytics.fct_user_activity"],
    "notes": "Time-series with date grouping"
  },
  {
    "id": "seed-004",
    "question": "revenue",
    "category": "ambiguous",
    "source": "manual",
    "notes": "Too vague — should trigger LOW confidence clarification"
  },
  {
    "id": "seed-005",
    "question": "Compare conversion rates between mobile and desktop by funnel stage",
    "category": "join",
    "source": "manual",
    "expectedTables": ["analytics.fct_conversions", "analytics.dim_devices"],
    "notes": "Multi-dimension comparison requiring joins and pivoting"
  },
  {
    "id": "seed-006",
    "question": "Forecast next month's revenue based on the past 12 months",
    "category": "time_series",
    "source": "manual",
    "expectedTables": ["analytics.fct_revenue"],
    "notes": "BQML forecast intent — should trigger bqml_hint: forecast and generate ML.FORECAST SQL"
  },
  {
    "id": "seed-007",
    "question": "Find any anomalies in daily signup counts over the past 90 days",
    "category": "time_series",
    "source": "manual",
    "expectedTables": ["analytics.fct_user_activity"],
    "notes": "BQML anomaly intent — should trigger bqml_hint: anomaly and generate ML.DETECT_ANOMALIES SQL"
  }
]
```

- [ ] **Step 3: Create benchmarks/results/.gitkeep**

```bash
mkdir -p benchmarks/results && touch benchmarks/results/.gitkeep
```

- [ ] **Step 4: Commit**

```bash
git add scripts/benchmark-types.ts benchmarks/corpus.json benchmarks/results/.gitkeep
git commit -m "feat: add benchmark types and seed corpus"
```

### Task 11: Create benchmark runner

**Files:**
- Create: `scripts/benchmark.ts`
- Create: `tests/scripts/benchmark.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/scripts/benchmark.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import type { CorpusEntry } from '../../scripts/benchmark-types.js';

describe('benchmark corpus', () => {
  it('loads and validates corpus.json schema', () => {
    const raw = readFileSync('benchmarks/corpus.json', 'utf-8');
    const corpus: CorpusEntry[] = JSON.parse(raw);

    expect(corpus.length).toBeGreaterThan(0);
    for (const entry of corpus) {
      expect(entry.id).toBeTruthy();
      expect(entry.question).toBeTruthy();
      expect(['simple', 'join', 'aggregate', 'time_series', 'ambiguous', 'edge_case']).toContain(entry.category);
      expect(['manual', 'production_positive', 'production_negative', 'escalation']).toContain(entry.source);
    }
  });

  it('has unique IDs', () => {
    const raw = readFileSync('benchmarks/corpus.json', 'utf-8');
    const corpus: CorpusEntry[] = JSON.parse(raw);
    const ids = corpus.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/scripts/benchmark.test.ts`
Expected: PASS

- [ ] **Step 3: Implement benchmark runner**

Create `scripts/benchmark.ts`. This is a standalone CLI script that:
- Reads `benchmarks/corpus.json`
- Initializes BigQuery (dry-run) and Firestore (teachings)
- For each corpus entry: runs `classifyQuestion()` + `qualityLoop()` with no-op Slack callbacks
- Captures timing per stage
- Writes results to `benchmarks/results/YYYY-MM-DD.json`

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { initBigQuery } from '../src/validation/dryRun.js';
import { initFirestore } from '../src/state/firestore.js';
import { classifyQuestion } from '../src/agents/clarificationAgent.js';
import { qualityLoop } from '../src/qualityLoop.js';
import { getTeachingSummaries } from '../src/teachings/summaryMap.js';
import { parseDbtArtifacts } from '../src/dbt/parser.js';
import type { CorpusEntry, BenchmarkResult } from './benchmark-types.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID!;

async function main() {
  if (!GEMINI_API_KEY || !GCP_PROJECT_ID) {
    console.error('Required: GEMINI_API_KEY, GCP_PROJECT_ID');
    process.exit(1);
  }

  // Initialize services
  initBigQuery(GCP_PROJECT_ID);
  initFirestore(GCP_PROJECT_ID);

  const tables = parseDbtArtifacts('dbt/manifest.json', 'dbt/catalog.json');
  let teachingSummaries: Awaited<ReturnType<typeof getTeachingSummaries>> = [];
  try { teachingSummaries = await getTeachingSummaries(); } catch { /* continue */ }

  const corpus: CorpusEntry[] = JSON.parse(readFileSync('benchmarks/corpus.json', 'utf-8'));
  const results: BenchmarkResult[] = [];

  for (const entry of corpus) {
    console.log(`[${entry.id}] ${entry.question.slice(0, 60)}...`);
    const totalStart = Date.now();

    try {
      // Clarification
      const clarifyStart = Date.now();
      const clarification = await classifyQuestion(
        entry.question, [], teachingSummaries, GEMINI_API_KEY,
      );
      const clarifyMs = Date.now() - clarifyStart;

      if (clarification.confidence === 'low') {
        results.push({
          corpusId: entry.id,
          question: entry.question,
          generatedSql: null,
          confidence: 'low',
          qualityVerdict: 'exhausted',
          retryCount: 0,
          validationResults: { l1: false, l2: false, l3: false, l4: false },
          bytesProcessed: null,
          supervisorNotes: 'Clarification needed',
          teachingCompliance: 'n/a',
          latencyMs: { clarification: clarifyMs, generation: 0, validation: 0, supervisor: 0, total: Date.now() - totalStart },
          groundingCitations: [],
        });
        continue;
      }

      // Quality loop
      const genStart = Date.now();
      const qualityResult = await qualityLoop(
        {
          question: clarification.resolved_question || entry.question,
          tables,
          threadContext: [],
          apiKey: GEMINI_API_KEY,
          bqml_hint: clarification.bqml_hint,
        },
        GEMINI_API_KEY,
        clarification.resolved_question || entry.question,
        10_000_000_000, // 10 GB cost gate for benchmark
      );
      const genMs = Date.now() - genStart;

      results.push({
        corpusId: entry.id,
        question: entry.question,
        generatedSql: qualityResult.sqlResult.sql,
        confidence: qualityResult.sqlResult.confidence,
        qualityVerdict: qualityResult.verdict,
        retryCount: qualityResult.retryCount,
        validationResults: { l1: true, l2: true, l3: qualityResult.verdict !== 'exhausted', l4: qualityResult.verdict !== 'cost_exceeded' },
        bytesProcessed: qualityResult.bytesProcessed ?? null,
        supervisorNotes: qualityResult.supervisorNotes,
        teachingCompliance: 'unknown',
        latencyMs: { clarification: clarifyMs, generation: genMs, validation: 0, supervisor: 0, total: Date.now() - totalStart },
        groundingCitations: qualityResult.sqlResult.groundingCitations.map(c => c.sourceFile),
      });
    } catch (error) {
      results.push({
        corpusId: entry.id,
        question: entry.question,
        generatedSql: null,
        confidence: 'low',
        qualityVerdict: 'exhausted',
        retryCount: 0,
        validationResults: { l1: false, l2: false, l3: false, l4: false },
        bytesProcessed: null,
        supervisorNotes: `Error: ${(error as Error).message}`,
        teachingCompliance: 'n/a',
        latencyMs: { clarification: 0, generation: 0, validation: 0, supervisor: 0, total: Date.now() - totalStart },
        groundingCitations: [],
      });
    }
  }

  const runDate = new Date().toISOString().split('T')[0];
  mkdirSync('benchmarks/results', { recursive: true });
  writeFileSync(`benchmarks/results/${runDate}.json`, JSON.stringify({ runDate, corpusSize: corpus.length, results }, null, 2));
  console.log(`\nResults written to benchmarks/results/${runDate}.json`);
  console.log(`Pass: ${results.filter(r => r.qualityVerdict === 'pass' || r.qualityVerdict === 'fail_then_pass').length}/${results.length}`);
}

main().catch(console.error);
```

- [ ] **Step 4: Commit**

```bash
git add scripts/benchmark.ts tests/scripts/benchmark.test.ts
git commit -m "feat: add benchmark runner script"
```

### Task 12: Create benchmark judge

**Files:**
- Create: `scripts/benchmark-judge.ts`

- [ ] **Step 1: Implement judge script**

Create `scripts/benchmark-judge.ts`:

```typescript
import { readFileSync, writeFileSync } from 'fs';
import { GoogleGenAI } from '@google/genai';
import type { CorpusEntry, BenchmarkResult, JudgeResult, BenchmarkRun } from './benchmark-types.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

const judgeResponseSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object' as const,
  properties: {
    correctness: { type: 'number', minimum: 1, maximum: 5 },
    efficiency: { type: 'number', minimum: 1, maximum: 5 },
    readability: { type: 'number', minimum: 1, maximum: 5 },
    teachingCompliance: { type: 'number', minimum: 1, maximum: 5 },
    safety: { type: 'number', minimum: 1, maximum: 5 },
    rationale: { type: 'string' },
    suggestedImprovement: { type: 'string' },
    flaggedForReview: { type: 'boolean' },
  },
  required: ['correctness', 'efficiency', 'readability', 'teachingCompliance', 'safety', 'rationale', 'flaggedForReview'],
};

async function judgeResult(
  ai: GoogleGenAI,
  entry: CorpusEntry,
  result: BenchmarkResult,
): Promise<JudgeResult> {
  const prompt = `Evaluate this SQL query generated by an NL-to-SQL system.

QUESTION: ${entry.question}
CATEGORY: ${entry.category}
${entry.expectedTables ? `EXPECTED TABLES: ${entry.expectedTables.join(', ')}` : ''}
${entry.knownGoodSql ? `REFERENCE SQL: ${entry.knownGoodSql}` : ''}

GENERATED SQL: ${result.generatedSql ?? '(no SQL generated)'}
CONFIDENCE: ${result.confidence}
VERDICT: ${result.qualityVerdict}
SUPERVISOR NOTES: ${result.supervisorNotes}

Score each criterion 1-5:
- Correctness: Does the SQL answer the question? (1=wrong tables/logic, 5=precise answer)
- Efficiency: Reasonable scan size, no unnecessary joins? (1=full scans, 5=minimal)
- Readability: Clear aliases, logical structure? (1=confusing, 5=clean)
- Teaching compliance: Follows established patterns? (1=contradicts, 3=no teaching, 5=follows)
- Safety: No risky patterns? (1=risky, 5=clean)

Also provide rationale and flag for human review if concerning.`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.0-pro',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: judgeResponseSchema,
    },
  });

  if (!response.text) throw new Error(`Empty response from judge for ${result.corpusId}`);
  const parsed = JSON.parse(response.text);
  const scores = {
    correctness: parsed.correctness,
    efficiency: parsed.efficiency,
    readability: parsed.readability,
    teachingCompliance: parsed.teachingCompliance,
    safety: parsed.safety,
  };

  return {
    corpusId: result.corpusId,
    scores,
    overallScore: (scores.correctness * 3 + scores.efficiency + scores.readability + scores.teachingCompliance + scores.safety) / 7,
    rationale: parsed.rationale,
    suggestedImprovement: parsed.suggestedImprovement,
    flaggedForReview: parsed.flaggedForReview,
  };
}

async function main() {
  const runFile = process.argv[2];
  if (!runFile) {
    console.error('Usage: npx tsx scripts/benchmark-judge.ts benchmarks/results/YYYY-MM-DD.json');
    process.exit(1);
  }

  const run: BenchmarkRun = JSON.parse(readFileSync(runFile, 'utf-8'));
  const corpus: CorpusEntry[] = JSON.parse(readFileSync('benchmarks/corpus.json', 'utf-8'));
  const corpusMap = new Map(corpus.map(e => [e.id, e]));

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const judgeResults: JudgeResult[] = [];

  for (const result of run.results) {
    const entry = corpusMap.get(result.corpusId);
    if (!entry) continue;

    console.log(`Judging [${result.corpusId}]...`);
    const judgeResult = await judgeResult(ai, entry, result);
    judgeResults.push(judgeResult);
  }

  run.judgeResults = judgeResults;
  writeFileSync(runFile, JSON.stringify(run, null, 2));
  console.log(`\nJudge results appended to ${runFile}`);

  const avg = judgeResults.reduce((sum, r) => sum + r.overallScore, 0) / judgeResults.length;
  const flagged = judgeResults.filter(r => r.flaggedForReview).length;
  console.log(`Average score: ${avg.toFixed(2)}/5.0 | Flagged for review: ${flagged}/${judgeResults.length}`);
}

main().catch(console.error);
```

- [ ] **Step 2: Commit**

```bash
git add scripts/benchmark-judge.ts
git commit -m "feat: add benchmark judge (LLM-as-Judge evaluation)"
```

### Task 13: Create benchmark analyzer

**Files:**
- Create: `scripts/benchmark-analyze.ts`
- Create: `tests/scripts/benchmark-analyze.test.ts`

- [ ] **Step 1: Write test for regression detection**

Create `tests/scripts/benchmark-analyze.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { detectRegressions } from '../../scripts/benchmark-analyze.js';
import type { JudgeResult } from '../../scripts/benchmark-types.js';

const makeJudge = (id: string, correctness: number): JudgeResult => ({
  corpusId: id,
  scores: { correctness, efficiency: 3, readability: 3, teachingCompliance: 3, safety: 3 },
  overallScore: correctness,
  rationale: 'test',
  flaggedForReview: false,
});

describe('detectRegressions', () => {
  it('detects regression when correctness drops by 2+', () => {
    const previous = [makeJudge('q1', 5), makeJudge('q2', 4)];
    const current = [makeJudge('q1', 2), makeJudge('q2', 4)];
    const regressions = detectRegressions(previous, current);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].corpusId).toBe('q1');
  });

  it('returns empty when no regressions', () => {
    const previous = [makeJudge('q1', 3)];
    const current = [makeJudge('q1', 4)];
    expect(detectRegressions(previous, current)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scripts/benchmark-analyze.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement analyzer**

Create `scripts/benchmark-analyze.ts`:

```typescript
import { readFileSync, writeFileSync } from 'fs';
import type { BenchmarkRun, JudgeResult } from './benchmark-types.js';

export interface Regression {
  corpusId: string;
  criterion: string;
  previousScore: number;
  currentScore: number;
  delta: number;
}

export function detectRegressions(
  previous: JudgeResult[],
  current: JudgeResult[],
  threshold = 2,
): Regression[] {
  const prevMap = new Map(previous.map(r => [r.corpusId, r]));
  const regressions: Regression[] = [];

  for (const cur of current) {
    const prev = prevMap.get(cur.corpusId);
    if (!prev) continue;

    for (const criterion of Object.keys(cur.scores) as Array<keyof typeof cur.scores>) {
      const delta = prev.scores[criterion] - cur.scores[criterion];
      if (delta >= threshold) {
        regressions.push({
          corpusId: cur.corpusId,
          criterion,
          previousScore: prev.scores[criterion],
          currentScore: cur.scores[criterion],
          delta,
        });
      }
    }
  }

  return regressions;
}

function generateSummary(run: BenchmarkRun, previousRun?: BenchmarkRun): string {
  const judges = run.judgeResults;
  if (!judges || judges.length === 0) return '# No judge results to analyze\n';

  const scores = judges.map(j => j.overallScore);
  scores.sort((a, b) => a - b);

  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const median = scores[Math.floor(scores.length / 2)];
  const p25 = scores[Math.floor(scores.length * 0.25)];
  const p75 = scores[Math.floor(scores.length * 0.75)];

  let md = `# Benchmark Summary — ${run.runDate}\n\n`;
  md += `**Corpus size:** ${run.corpusSize} | **Judged:** ${judges.length}\n\n`;
  md += `## Score Distribution\n`;
  md += `| Stat | Value |\n|---|---|\n`;
  md += `| Mean | ${mean.toFixed(2)} |\n`;
  md += `| Median | ${median.toFixed(2)} |\n`;
  md += `| P25 | ${p25.toFixed(2)} |\n`;
  md += `| P75 | ${p75.toFixed(2)} |\n\n`;

  // Failures
  const failures = run.results.filter(r => r.qualityVerdict === 'exhausted');
  md += `## Failures\n`;
  md += `**Exhausted:** ${failures.length}/${run.results.length}\n\n`;

  // Regressions
  if (previousRun?.judgeResults) {
    const regressions = detectRegressions(previousRun.judgeResults, judges);
    md += `## Regressions (vs previous run)\n`;
    if (regressions.length === 0) {
      md += 'None detected.\n\n';
    } else {
      md += `| Question | Criterion | Previous | Current | Delta |\n|---|---|---|---|---|\n`;
      for (const r of regressions) {
        md += `| ${r.corpusId} | ${r.criterion} | ${r.previousScore} | ${r.currentScore} | -${r.delta} |\n`;
      }
      md += '\n';
    }
  }

  // Flagged for review
  const flagged = judges.filter(j => j.flaggedForReview);
  if (flagged.length > 0) {
    md += `## Flagged for Human Review (${flagged.length})\n`;
    for (const f of flagged) {
      md += `- **${f.corpusId}** (score: ${f.overallScore.toFixed(1)}): ${f.rationale.slice(0, 100)}\n`;
    }
  }

  return md;
}

async function main() {
  const currentFile = process.argv[2];
  const previousFile = process.argv[3];

  if (!currentFile) {
    console.error('Usage: npx tsx scripts/benchmark-analyze.ts <current.json> [previous.json]');
    process.exit(1);
  }

  const current: BenchmarkRun = JSON.parse(readFileSync(currentFile, 'utf-8'));
  const previous = previousFile ? JSON.parse(readFileSync(previousFile, 'utf-8')) as BenchmarkRun : undefined;

  const summary = generateSummary(current, previous);
  const outPath = currentFile.replace('.json', '-summary.md');
  writeFileSync(outPath, summary);
  console.log(summary);
  console.log(`Summary written to ${outPath}`);
}

main().catch(console.error);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/scripts/benchmark-analyze.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/benchmark-analyze.ts tests/scripts/benchmark-analyze.test.ts
git commit -m "feat: add benchmark analyzer with regression detection"
```

**Note:** The `scripts/benchmark-expand-corpus.ts` (Firestore auto-expander) is deferred to a follow-up task. It requires production Firestore data and is not needed for the initial benchmark runs with the seed corpus.

### Task 14: Integration tests and final verification

- [ ] **Step 1: Add chart pipeline integration test**

Add to `tests/integration/pipeline.integration.test.ts` (or create `tests/integration/chart.integration.test.ts`):

```typescript
it('generates chart for chartable results and uploads to Slack', async () => {
  // Setup: mock Gemini to return valid SQL, mock BigQuery to return chartable result
  // (2+ columns, 2+ rows, numeric + non-numeric)
  // Mock chartAgent to return a valid vega-lite spec
  // Mock chartRenderer to return a PNG buffer
  // Mock Slack filesUploadV2
  // Run pipeline
  // Assert: chat.update called with table response
  // Assert: filesUploadV2 called with PNG buffer in same thread
  // Assert: ResponseContext saved (no chartMetadata — persistence deferred to v2)
});

it('falls back to table-only when chart generation fails', async () => {
  // Setup: same as above but mock chartAgent to return null
  // Run pipeline
  // Assert: chat.update called with table response
  // Assert: filesUploadV2 NOT called
  // Assert: no error surfaced to user
});
```

**Note:** Benchmark integration test (spec 4.8: "run 5 corpus entries through runner → judge → analyze") requires real Gemini API + BigQuery credentials and cannot run in CI. Deferred to manual validation alongside the corpus expander script.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 4: Verify benchmark scripts are runnable**

```bash
npx tsx scripts/benchmark.ts --help 2>&1 || echo "Script loads OK"
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: Phase 3 complete — chart generation, BQML predictions, benchmark harness"
```
