# Model Refresh via Quorum-Labeled Template Validation Set — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A repeatable, developer-run procedure (discover models → register → sweep a frozen,
quorum-labeled, template-safe validation set → review a local report → update defaults) that
can size all 12 `generateForNode` nodes.

**Architecture:** The model registry in `src/agents/modelConfig.ts` grows real prices and a
status. A new `scripts/template-validation/` module owns the public-data warehouse setup, the
item schemas, deterministic scorers, the CLI-labeler quorum and the template-mode corpus
runners. `scripts/node-sweep.ts`'s existing `runSweep` (ε calibration + two-stage search +
`pickWithinEpsilon`) is the single sizing engine for every node in template mode. Each node
gets an injected `runCorpusOnce` whose `PerEntry` values come from deterministic scorers.

**Tech Stack:** TypeScript (NodeNext ESM, tsx for scripts), vitest, `@google/genai`,
`@google-cloud/bigquery`, zod, `yaml`, and headless `claude` / `codex` / `agy` / `gemini` CLIs
(external, developer-installed).

**Spec:** `docs/superpowers/specs/2026-11-18-model-refresh-validation-design.md` (its "Planning amendments" section records where this plan departs from the original design: single `runSweep` engine, `tv_thelook` views, generated dbt artifacts, `teachingCandidate` label, extracted summary agent, clarification bypass on `sqlGenerator` items).

## Global Constraints

- Runtime stays Gemini-only. No new LLM SDK dependency. Non-Gemini models are reached only via local agent CLIs from `scripts/`.
- Labeling code lives in `scripts/`, never `src/`. Module rules hold (`agents/` never imports `slack/`/`state/`, etc.).
- Refresh reports are written to gitignored `benchmarks/results/` and **never committed**. The validation set (items + provenance + knowledge + dbt artifacts) **is** committed.
- The validation set is template-safe: no project IDs, emails, or datasets other than the views over `bigquery-public-data.thelook_ecommerce`.
- Existing `NODE_PROFILE_OVERRIDES` (`{tier, version, thinkingLevel}`) and `MODEL_ID_OVERRIDES` (`"tier/version"` keys) must keep parsing unchanged.
- Quorum agreement is **unanimous**. Default 3 distinct families; 2 → `reducedQuorum: true`; 1 → refused unless `--allow-single-family` (→ `singleFamily: true`). CLIs from the same family count once.
- Meaningful delta = **0.05** on a 0–1 metric. A row is *applicable* only if ε ≤ 0.05 and the result isn't flat-at-floor.
- SQL equivalence: numeric tolerance **1e-6 relative**, NULL-safe, column order ignored. Row order counts only when the reference has `ORDER BY` + `LIMIT`.
- Item targets: about 40 per closed-set/rule node; about 100 each for `sqlGenerator` and `supervisor`. Labeling batches are about 20 items per CLI call.
- `*-latest` model aliases are never registered.
- Don't run the template sweep concurrently with `universal-sweep` or another `node-sweep`.
- Governance: the change set updates `docs/trajectory-governance.md` and `src/agents/CLAUDE.md` (Task 12).

## Review Focus

1. **A labeler CLI returns prose, a code fence, or truncated JSON instead of schema-valid output.** The item must be recorded as that member's *failure* (it goes to quarantine), never silently dropped or treated as agreement. Test: Task 7 `parseLabelerOutput rejects fenced/prose/invalid JSON`.
2. **Candidate SQL that executes but returns 0 rows, when the reference also returns 0 rows.** Two empty results are equivalent *only* if the column counts match. Otherwise a broken query would "agree" with a trivial one. Test: Task 5 `empty results equivalent only with equal column count`.
3. **A sweep interrupted mid-run (429, laptop sleep).** It must abort cleanly, and a labeling run must resume from the cache without re-billing finished batches. Test: Task 7 `cache hit skips spawn`, Task 9 `resume uses cached answers`.
4. **An operator's own knowledge layer or `FILE_SEARCH_STORE_ID` set in `.env` during a template run.** Template mode must ignore both. Test: Task 11 `template mode ignores FILE_SEARCH_STORE_ID and repo knowledge`.
5. **A registry model that's no longer live (retired preview ID) still used by a default.** Discovery must report it as *missing in use*. Test: Task 3 `diffModels flags missing models referenced by defaults`.

---

### Task 1: Generalize the model registry

**Files:**
- Modify: `src/agents/modelConfig.ts`
- Modify (rename callers): `src/agents/nodeProfiles.ts`, `scripts/node-sweep.ts`, `scripts/node-sweep-smoke.ts`, `scripts/universal-sweep.ts`, `scripts/universal-sweep-core.ts` (comments), `src/agents/CLAUDE.md` (mentions)
- Test: `tests/agents/modelConfig.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ModelStatus = 'candidate' | 'default-eligible' | 'retired';
  export interface RegisteredModel {
    tier: ModelTier; version: string; id: string;
    thinkingLevels: Exclude<ThinkingLevel, 'default'>[];
    inputPricePerMTok: number; outputPricePerMTok: number; // USD; thoughts bill as output
    status: ModelStatus;
  }
  export function listRegisteredModels(): ModelCoordinate[];          // non-retired, cheapest tier first
  export function getRegisteredModel(tier: ModelTier, version: string): RegisteredModel | undefined;
  export function listAllRegisteredModels(): RegisteredModel[];       // incl. retired (for discovery)
  ```
  `getSupportedThinkingLevels` and `resolveModelId` keep their signatures. `listGemini3xModels` is **removed** (all callers renamed in this task).

- [ ] **Step 1: Write failing tests** in `tests/agents/modelConfig.test.ts`:
  - `every registered model has positive input and output prices`: for each `listAllRegisteredModels()` entry, `inputPricePerMTok > 0 && outputPricePerMTok > 0`.
  - `listRegisteredModels excludes retired`: for every coordinate returned, `getRegisteredModel(tier, version)!.status !== 'retired'`, and `listAllRegisteredModels().length >= listRegisteredModels().length`.
  - `no registered id ends with -latest`.
  - Update the existing parity test to: every entry declares `thinkingLevels.length > 0`, and `getSupportedThinkingLevels('pro','3.1')` does not include `'minimal'`.
  - `legacy override formats still resolve`: `MODEL_ID_OVERRIDES='{"flash/3":"x-model"}'` → `resolveModelId('flash','3') === 'x-model'`; the existing `NODE_PROFILE_OVERRIDES` tests in `tests/agents/nodeProfiles.test.ts` pass unchanged.
- [ ] **Step 2: Run** `npx vitest run tests/agents/modelConfig.test.ts`. Expected: FAIL (`listAllRegisteredModels` not exported).
- [ ] **Step 3: Implement.** Replace `GEMINI_3X_MODELS` + `MODEL_THINKING_LEVELS` with one `REGISTRY: Record<string, RegisteredModel>` keyed `${tier}/${version}`. Keep the four current entries (`status: 'default-eligible'`). Set prices from https://ai.google.dev/gemini-api/docs/pricing (standard tier, ≤200K-token prompts) at implementation time. Rename `listGemini3xModels` → `listRegisteredModels` in every caller listed above.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run tests/agents tests/scripts`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor: model registry with prices and status; rename listGemini3xModels`.

### Task 2: Sweep cost from registry prices

**Files:**
- Modify: `scripts/node-sweep.ts` (`TIER_PRICES`, `nodeCost`, `CorpusRunResult.nodeUsage`, sink in `createRunCorpusOnce`)
- Modify: `scripts/node-sweep-smoke.ts` if it reads `nodeUsage.tokens`
- Test: `tests/scripts/nodeSweep.test.ts`

**Interfaces:**
- Consumes: `getRegisteredModel` (Task 1).
- Produces: `CorpusRunResult.nodeUsage: Map<NodeId, { latencies: number[]; inputTokens: number; outputTokens: number }>`, where `outputTokens = candidatesTokens + thoughtsTokens`. Also `export function nodeCost(node: NodeId, profile: { tier: ModelTier; version: string }, usage: CorpusRunResult['nodeUsage']): number` = `inputTokens/1e6*inputPrice + outputTokens/1e6*outputPrice`.

- [ ] **Step 1: Failing test** `nodeCost uses per-model input/output prices`: usage `{inputTokens: 2_000_000, outputTokens: 1_000_000}` on `pro/3.1` → `2*in + 1*out` for that registry entry. Update existing fakes in `nodeSweep.test.ts` that build `nodeUsage` to the new shape.
- [ ] **Step 2: Run** `npx vitest run tests/scripts/nodeSweep.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Delete `TIER_PRICES`. Baseline cost uses `defaultProfileForNode(node)` (not just its tier).
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run tests/scripts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sweep): cost from registry per-model prices`.

### Task 3: Model discovery script

**Files:**
- Create: `scripts/model-discover-core.ts`, `scripts/model-discover.ts`
- Modify: `package.json` (`"model:discover": "tsx --env-file=.env scripts/model-discover.ts"`)
- Test: `tests/scripts/modelDiscover.test.ts`

**Interfaces:**
- Consumes: `listAllRegisteredModels`, `defaultProfileForNode`, `NODE_IDS`, `resolveModelId`.
- Produces:
  ```ts
  export function isTextGenerationModel(id: string): boolean;
  export interface ModelDiff { added: string[]; missing: { id: string; usedByDefaults: NodeId[] }[]; unchanged: string[] }
  export function diffModels(liveIds: string[], registry: RegisteredModel[], defaultIds: Map<NodeId, string>): ModelDiff;
  export async function probeThinkingLevels(id: string, call: (id: string, level: string) => Promise<void>): Promise<string[]>; // levels that did NOT throw
  export function formatRegistryStub(id: string, levels: string[]): string; // tier/version/price left as TODO
  ```

- [ ] **Step 1: Failing tests:**
  - `isTextGenerationModel excludes non-text and aliases`: false for `gemini-3-pro-image`, `gemini-3.8-flash-tts`, `gemini-3.5-transcribe`, `gemini-2.5-computer-use-preview-10-2025`, `gemini-robotics-er-2-preview`, `gemini-nano-banana-2.1`, `gemini-omni-1.2-flash`, `gemini-3.1-pro-preview-customtools`, `gemini-flash-latest`. True for `gemini-3.8-flash`, `gemini-4-neon`, `gemini-3.5-flash-lite`.
  - `diffModels flags missing models referenced by defaults`: registry has `gemini-3-flash-preview` (used by `dbtStatus`), live list lacks it → `missing[0].usedByDefaults` contains `'dbtStatus'`.
  - `probeThinkingLevels records rejected levels`: fake `call` throws for `'minimal'` → result `['low','medium','high']`.
- [ ] **Step 2: Run** `npx vitest run tests/scripts/modelDiscover.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the core, then a CLI that uses `ai.models.list()`, keeps text models, prints the diff, and probes each added model with a 1-token `generateContent` per level (`thinkingConfig.thinkingLevel`). Read-only, never writes source.
- [ ] **Step 4: Run** the tests (PASS), then live: `npm run model:discover`. Expected: lists `gemini-3.8-flash` etc. as added. No source files change.
- [ ] **Step 5: Commit** `feat: model:discover — live model diff + thinking-level probe`.

### Task 4: Template warehouse, dbt artifacts, and synthetic knowledge layer

**Files:**
- Create: `benchmarks/template-validation/VERSION` (`tv-v1`)
- Create: `benchmarks/template-validation/dbt/models.yml`: dbt `models:` YAML for the 7 thelook tables (`orders, order_items, users, products, inventory_items, events, distribution_centers`) under schema `tv_thelook`, with a description for every table and documented column.
- Create: `benchmarks/template-validation/dbt/manifest.json`, `catalog.json` (generated, committed)
- Create: `benchmarks/template-validation/knowledge/references/*.yml` (3–4 generic ReferenceCards) and `knowledge/teachings/*.yml` (2–3 Teachings), in the formats of `references/examples/revenue.yml` and `tests/fixtures/teachings/revenue-metrics.yml`. Examples: revenue excludes `order_items.status IN ('Cancelled','Returned')`; "active user" = ≥1 `events` row in the window; order counts use `orders.order_id`, not `order_items`.
- Create: `scripts/template-validation/warehouse.ts` (setup CLI + `buildArtifacts` core)
- Modify: `package.json` (`"tv:setup": "tsx --env-file=.env scripts/template-validation/warehouse.ts"`)
- Test: `tests/scripts/templateValidation/warehouse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TV_DATASET = 'tv_thelook';
  export const TV_TABLES = ['orders','order_items','users','products','inventory_items','events','distribution_centers'] as const;
  export function viewDdl(projectId: string, table: string): string; // CREATE OR REPLACE VIEW `${projectId}.tv_thelook.${table}` AS SELECT * FROM `bigquery-public-data.thelook_ecommerce.${table}`
  export function buildArtifacts(modelsYaml: string, columns: { table: string; column: string; dataType: string }[]): { manifest: object; catalog: object };
  export const TV_ROOT = 'benchmarks/template-validation';
  ```
  Decision (plan): models are **views in the operator's project** because `parseDbtArtifacts` names tables `schema.name` with no project, so `tv_thelook.orders` resolves against the default project. Artifacts are generated by `buildArtifacts` from the YAML + `INFORMATION_SCHEMA.COLUMNS`, so no dbt install is needed. The emitted `metadata.dbt_schema_version` must be a version `parseDbtArtifacts` accepts without warning.

- [ ] **Step 1: Failing tests:**
  - `buildArtifacts round-trips through parseDbtArtifacts`: parsing the emitted manifest/catalog yields 7 `TableContext`s named `tv_thelook.<table>` with the YAML descriptions, no version warning, and `dataType` from `columns`.
  - `viewDdl targets the public dataset`: contains `` `bigquery-public-data.thelook_ecommerce.orders` `` and `` `p.tv_thelook.orders` `` for `('p','orders')`.
  - `knowledge layer loads`: `loadLocalKnowledgeSummaries('benchmarks/template-validation/knowledge')` returns ≥5 summaries.
- [ ] **Step 2: Run** `npx vitest run tests/scripts/templateValidation/warehouse.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The CLI creates the dataset `tv_thelook` (location `US`) if absent, creates or replaces the 7 views, queries `INFORMATION_SCHEMA.COLUMNS` on the views, and writes `manifest.json`/`catalog.json`.
- [ ] **Step 4: Run** the tests (PASS), then live `npm run tv:setup`. Expected: 7 views exist. Then a dry run of `SELECT COUNT(*) FROM tv_thelook.orders` through `validateSql` passes L1–L4.
- [ ] **Step 5: Commit** `feat(tv): public-data warehouse views, dbt artifacts, synthetic knowledge layer` (artifacts contain no project ID; verify with `grep -r "$GCP_PROJECT_ID" benchmarks/template-validation` → nothing).

### Task 5: SQL result equivalence

**Files:**
- Create: `scripts/template-validation/resultEquivalence.ts`
- Test: `tests/scripts/templateValidation/resultEquivalence.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function referenceIsOrdered(sql: string): boolean; // top-level ORDER BY AND LIMIT
  export function resultsEquivalent(
    ref: { columnNames: string[]; rows: Record<string, unknown>[] },
    cand: { columnNames: string[]; rows: Record<string, unknown>[] },
    opts: { ordered: boolean; relTol?: number /* default 1e-6 */ },
  ): boolean;
  ```
  Algorithm (plan): column *names* are ignored (aliases differ). Each row is canonicalized to the **sorted** list of its normalized values (numbers, including BigQuery numeric/`BigQueryDate`-like objects stringified then parsed; NULL → a sentinel). Compare as multisets, or as sequences when `ordered`. Numbers compare with `|a-b| ≤ relTol·max(|a|,|b|,1e-12)`, so sorting numbers needs a tolerance-aware match (greedy pairing per row is fine at these sizes).

- [ ] **Step 1: Failing tests:** `ignores column order and aliases`; `numeric tolerance 1e-6 relative` (1000000 vs 1000000.5 → true; 1 vs 1.01 → false); `NULL equals NULL, NULL not 0`; `row order ignored unless ordered`; `empty results equivalent only with equal column count`; `different row counts not equivalent`; `referenceIsOrdered` true for `... ORDER BY x DESC LIMIT 10`, false for `ORDER BY` without `LIMIT` and for `ORDER BY` only inside a subquery/window.
- [ ] **Step 2: Run** `npx vitest run tests/scripts/templateValidation/resultEquivalence.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(tv): executed-result SQL equivalence`.

### Task 6: Item schemas, loaders, template-safety scan

**Files:**
- Create: `scripts/template-validation/items.ts`
- Test: `tests/scripts/templateValidation/items.test.ts`

**Interfaces:**
- Produces (zod schemas + inferred types, one per node; all items have `id`, `category` (the `CorpusEntry.category` union), `inputHash`, and `agreement: { members: string[] }`, i.e. the labeler ids that unanimously agreed; seeded manual items use `members: ['manual']`):
  - `slackIntake {text, expectedRoute}`; `followUpClassifier {thread, message, expectedIntent}`
  - `ambiguityClassifier {input: AmbiguityClassifierInput, expectedType: AmbiguityType}`
  - `clarification {question, expectedSuspend: boolean}` (true = LOW)
  - `teachingCandidate {context: Omit<EscalationTeachingContext,'apiKey'>, expectSanctionedSql: boolean, requiredModels: string[]}`. Note: `generateTeachingCandidate` always returns a candidate, so the spec's "should-create yes/no" is implemented as "sanctionedSql present vs null".
  - `sqlGenerator {question, referenceSql}`; `supervisor {question, candidateSql, expectedVerdict: 'PASS'|'FAIL', mutationOf?: string}`
  - `dbtStatus {question, runHistoryFixture: string, requiredFacts: string[]}`
  - `chart {question, columnNames, sampleRows, allowedMarks: string[]}`
  - `summaryOverride {question, sql, rows, totalRows}`
  - `metaQuestion {question, contextFixture: string, rubric: string[]}`; `discrepancy {complaint, contextFixture: string, defect: string, rubric: string[]}`
  ```ts
  export const ITEM_SCHEMAS: Record<NodeId, z.ZodType>;
  export function loadItems<N extends NodeId>(node: N, root?: string): Item<N>[]; // items/<node>.jsonl, validated
  export function scanTemplateSafety(text: string): string[]; // violations: GCP project-id-like `x.y.z` refs other than tv_thelook./bigquery-public-data.thelook_ecommerce, emails, `projects/<id>`
  export function hashItemInput(item: unknown): string; // sha256 of canonical JSON of input fields
  export function hashValidationSet(root?: string): string; // sha256 over VERSION + sorted items/*.jsonl + knowledge/** + fixtures/** + dbt/*.json (paths and bytes); recorded in every refresh report
  ```
  Fixtures (`fixtures/*.json`) are referenced by name; `loadFixture(name)` lives here too.

- [ ] **Step 1: Failing tests:** `loadItems rejects a malformed line with its line number`; `scanTemplateSafety flags emails and foreign datasets` (`a@b.com`, `` `acme-prod.analytics.orders` `` flagged; `tv_thelook.orders` clean); `hashItemInput is key-order independent`; `hashValidationSet changes when any item byte changes and ignores quarantine/ and .cache/`.
- [ ] **Step 2: Run** `npx vitest run tests/scripts/templateValidation/items.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Seed `items/slackIntake.jsonl` and `items/followUpClassifier.jsonl` by converting the 26 entries of `benchmarks/universal-corpus.json`, with provenance `source: 'manual'`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(tv): per-node item schemas, loaders, template-safety scan`.

### Task 7: Labeler CLI adapters

**Files:**
- Create: `benchmarks/template-validation/labelers.json`
- Create: `scripts/template-validation/labelers.ts`
- Create: `tests/fixtures/labeler-output/{claude,codex,agy,gemini}.txt` (captured real outputs, Step 3)
- Modify: `.gitignore` (`benchmarks/template-validation/.cache/`)
- Test: `tests/scripts/templateValidation/labelers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LabelerConfig {
    id: string; family: 'anthropic' | 'openai' | 'google';
    argv: string[];               // template tokens: {prompt}, {schemaPath}, {schemaJson}, {model}
    outputParser: 'claude-json' | 'codex-jsonl' | 'agy-json' | 'gemini-json';
    model: string;
    effortArgs: string[];         // the CLI's flags for its highest reasoning/thinking level (spec: label at highest thinking level); appended to argv
    versionArgv: string[];        // e.g. ['--version']
  }
  export function loadLabelers(path?: string): LabelerConfig[];
  export function buildArgv(cfg: LabelerConfig, vars: { prompt: string; schemaPath: string; schemaJson: string }): string[];
  export function parseLabelerOutput(parser: LabelerConfig['outputParser'], stdout: string): { value: unknown; reportedModel?: string };
  export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ stdout: string; code: number }>;
  export async function runLabeler(cfg: LabelerConfig, batch: { prompt: string; schema: z.ZodType; cacheKey: string }, spawn: SpawnFn, cacheDir: string): Promise<{ value: unknown; reportedModel?: string; cached: boolean }>;
  export async function checkAvailable(cfg: LabelerConfig, spawn: SpawnFn): Promise<{ ok: boolean; version?: string }>;
  ```
  `labelers.json` defaults (re-verify each with `<cli> --help`):
  - claude: `claude -p {prompt} --output-format json --json-schema {schemaJson} --model {model} --tools ""`
  - codex: `codex exec --json --output-schema {schemaPath} -s read-only -m {model} {prompt}`
  - agy: `agy -p {prompt} --output-format json --json-schema {schemaPath} --mode plan --model {model}`
  - gemini: `gemini -p {prompt} -o json --approval-mode plan -m {model}`
  `effortArgs` defaults: verify at build time with each CLI's `--help` (e.g. codex `-c model_reasoning_effort="high"`). Where a CLI has no such flag, pick the model id that implies maximum thinking and leave `effortArgs: []`; record it in `labelers.json`.
  `runLabeler` creates a fresh `mkdtemp` dir, writes only `schema.json` there, uses it as `cwd`, deletes it afterwards, and validates fresh and cached values against the source Zod schema. It emits JSON Schema for the CLI and checks Codex strict-schema compatibility before reading the cache or spawning. A non-zero exit or invalid output throws `LabelerOutputError`. Cache: `<cacheDir>/<labelerId>/<model>/<cacheKey>.json`.

- [ ] **Step 1: Failing tests:** `buildArgv substitutes all tokens and appends effortArgs`; `parseLabelerOutput rejects fenced/prose/invalid JSON` (for each parser: a ```` ```json ```` fence, prose, truncated JSON → throws `LabelerOutputError`); `parses captured real output` (each fixture → the expected `value`); `runLabeler uses an empty temp cwd` (fake spawn asserts `cwd` contains only `schema.json` and is not under the repo); `cache hit skips spawn`.
- [ ] **Step 2: Run** `npx vitest run tests/scripts/templateValidation/labelers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Capture fixtures.** Run each installed CLI once with the argv above on a trivial schema (`{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}`, prompt "Reply with answer=ok") and save stdout to `tests/fixtures/labeler-output/<cli>.txt`. Confirm the lock-down flag works: prompt it to list the files in its cwd; it must not use a tool. Record any flag that differs from the defaults in `labelers.json`.
- [ ] **Step 4: Implement**, then run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tv): headless agent-CLI labeler adapters with isolation + cache`.

### Task 8: Quorum agreement rules

**Files:**
- Create: `scripts/template-validation/quorum.ts`
- Test: `tests/scripts/templateValidation/quorum.test.ts`

**Interfaces:**
- Consumes: `resultsEquivalent`, `referenceIsOrdered` (Task 5); `LabelerConfig` (Task 7).
- Produces:
  ```ts
  export type QuorumKind = 'full' | 'reduced' | 'single';
  export function validateQuorum(members: LabelerConfig[], allowSingleFamily: boolean): { members: LabelerConfig[]; kind: QuorumKind }; // dedupes by family (first wins); throws on 0, or on 1 family without the flag
  export function agreeClosedSet<T extends string | boolean>(labels: (T | Error)[]): { agreed: true; value: T } | { agreed: false };
  export async function agreeSql(sqls: (string | Error)[], execute: (sql: string) => Promise<QueryResultLike | Error>): Promise<{ agreed: true; reference: string } | { agreed: false; reason: string }>; // all execute OK + pairwise equivalent vs first; reference = shortest
  export function agreeRubric(proposed: string[], votes: boolean[][]): string[]; // facts every member kept
  ```
  Any `Error` member → not agreed (`reason` names the member).

- [ ] **Step 1: Failing tests:** `validateQuorum counts agy+gemini as one family`; `validateQuorum refuses single family without flag`; `agreeClosedSet requires unanimity`; `agreeClosedSet: any member error means no agreement`; `agreeSql picks shortest equivalent reference`; `agreeSql disagrees when one query fails validation`; `agreeRubric keeps only facts all members kept`.
- [ ] **Step 2: Run** `npx vitest run tests/scripts/templateValidation/quorum.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `execute` is injected; the CLI wires it to `validateSql` and then `executeQuery` with `{maxRows: 10_000, timeoutMs: 60_000, maxBytes: 1 GiB}`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(tv): unanimous quorum agreement rules`.

### Task 9: `label-quorum` orchestration CLI

**Files:**
- Create: `scripts/template-validation/labelQuorum.ts` (orchestrator, IO injected), `scripts/template-validation/label-quorum.ts` (CLI), `scripts/template-validation/prompts.ts` (per-node generation, labeling and SQL-mutation prompts + JSON schemas)
- Create: `benchmarks/template-validation/fixtures/` (dbt run-history, ResponseContext and escalation-resolution fixtures, drafted in Step 3)
- Modify: `package.json` (`"tv:label": "tsx --env-file=.env scripts/template-validation/label-quorum.ts"`)
- Test: `tests/scripts/templateValidation/labelQuorum.test.ts`

**Interfaces:**
- Consumes: Tasks 4–8.
- Produces:
  ```ts
  export interface LabelRunDeps { labelers: LabelerConfig[]; runLabeler: typeof runLabeler; execute: (sql: string) => Promise<QueryResultLike | Error>; root: string; now: () => Date }
  export async function labelNode(node: NodeId, drafts: unknown[], deps: LabelRunDeps): Promise<{ accepted: unknown[]; quarantined: { item: unknown; labels: Record<string, unknown> }[] }>;
  export async function runLabelQuorum(opts: { nodes: NodeId[]; allowSingleFamily: boolean; drafter: string; targetCounts: Partial<Record<NodeId, number>> }, deps: LabelRunDeps): Promise<Provenance>;
  export interface Provenance { version: string; createdAt: string; quorumKind: QuorumKind; reducedQuorum: boolean; singleFamily: boolean; drafter: string;
    members: { id: string; family: string; cliVersion: string; requestedModel: string; reportedModels: string[] }[];
    perNode: Record<string, { drafted: number; accepted: number; quarantined: number; dropRateByCategory: Record<string, number> }> }
  ```
  Flow per node: the drafter labeler generates item inputs in batches of 20, spread over the categories, until `targetCounts` (defaults: 40, or 100 for `sqlGenerator`/`supervisor`). Every quorum member then labels every batch **blind**. Agreement uses Task 8. Supervisor drafting starts from accepted `sqlGenerator` items: each member mutates a reference query, and a mutation is kept only if it passes `validateSql` and is **not** `resultsEquivalent` to the reference. Those become `expectedVerdict: 'FAIL'` items; the references themselves become `'PASS'` items. `clarification` drafts must include items that are ambiguous without a knowledge card and clear with it (the prompt passes the synthetic knowledge in). Production SQL generation receives organization knowledge through File Search, and the supervisor receives it through generator citations. The template set cannot replicate File Search. SQL generation and supervisor items use the documented schema for drafting, mutation, labeling, and scoring. Before writing, every accepted item goes through `scanTemplateSafety`; any violation aborts the run. Outputs: `items/<node>.jsonl`, `quarantine/<node>.jsonl`, `provenance.json`. If `items/` already exists and `VERSION` is unchanged, the run refuses ("bump VERSION to relabel"). At startup the CLI runs `checkAvailable` on every configured labeler, prints which are usable with their versions, and runs `validateQuorum` on the usable ones before any billed call. Nodes are labeled in dependency order: `sqlGenerator` before `supervisor`. Each accepted item records `agreement.members`.

- [ ] **Step 1: Failing tests** (fake labelers + fake execute): `unanimous items are accepted, split items quarantined`; `supervisor mutation equivalent to reference is discarded`; `safety violation aborts before writing`; `refuses to overwrite same VERSION`; `resume uses cached answers` (second run → zero spawns); `provenance records reducedQuorum for two families`; `unavailable labeler is excluded before quorum validation`; `accepted items record agreement members`.
- [ ] **Step 2: Run** `npx vitest run tests/scripts/templateValidation/labelQuorum.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the orchestrator, prompts and CLI (`--node`, `--allow-single-family`, `--drafter <labelerId>`, default `claude`). Draft the fixture files with the drafter in the same run; they're committed with the items.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(tv): label-quorum orchestration (blind, unanimous, resumable)`.

### Task 10: Deterministic node scorers + extracted summary agent

**Files:**
- Create: `src/agents/summaryAgent.ts`
- Modify: `src/handlers/responseOverrides.ts` (call `summarizeResults`; behavior unchanged). Leave `src/whatsapp/overrides.ts` untouched (gated surface; no governance-scope change).
- Create: `scripts/template-validation/scorers.ts`
- Test: `tests/agents/summaryAgent.test.ts`, `tests/scripts/templateValidation/scorers.test.ts`, existing `tests/handlers/responseOverrides*.test.ts` stay green

**Interfaces:**
- Produces:
  ```ts
  // src/agents/summaryAgent.ts — exact prompt text moved verbatim from responseOverrides.ts:94-101
  export async function summarizeResults(input: { question: string; sql: string; rows: Record<string, unknown>[]; totalRows: number; apiKey: string }): Promise<string>;
  // scorers.ts — each returns 0..1
  export function scoreChart(spec: ChartSpec | null, item: ChartItem): number;            // 1 iff spec non-null, mark ∈ allowedMarks, every encoding.field ∈ columnNames, and renderChart() resolves
  export function scoreSummaryNumbers(summary: string, rows: Record<string, unknown>[]): number; // fraction of numbers in summary that match a row value (tolerance 1e-6 rel, or same value rounded to the summary's precision; %/k/M suffixes parsed); 0 if summary empty; 1 if it states no numbers
  export function scoreFacts(text: string, requiredFacts: string[]): number;           // case-insensitive containment fraction (dbtStatus)
  export function scoreTeachingCandidate(c: TeachingCandidate, item: TeachingCandidateItem): number; // mean of [sanctionedSql presence == expectSanctionedSql, requiredModels ⊆ modelsReferenced]
  export async function scoreRubric(text: string, rubric: string[], judge: (text: string, fact: string) => Promise<boolean>): Promise<number>;
  ```
  `summaryOverride`'s template score = `scoreSummaryNumbers` (rule) **and** `scoreRubric` with a single fact ("answers the question asked"). Metric = the mean of the two. Flagged `medium`.

- [ ] **Step 1: Failing tests:** `summarizeResults sends the same prompt as before` (mocked `generateForNode` receives the verbatim text); `scoreChart rejects encodings naming absent fields`; `scoreSummaryNumbers: "$1.2M" matches 1234567 at stated precision, "42%" matches 0.42`; `scoreSummaryNumbers: hallucinated number lowers score`; `scoreFacts case-insensitive`; `scoreTeachingCandidate halves when models missing`.
- [ ] **Step 2: Run** `npx vitest run tests/agents/summaryAgent.test.ts tests/scripts/templateValidation/scorers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS (full suite, incl. the overrides tests).
- [ ] **Step 5: Commit** `feat(tv): deterministic node scorers; extract summarizeResults`.

### Task 11: Template-mode sweep (`node-sweep --corpus template`) + local refresh report

**Files:**
- Create: `scripts/template-validation/runners.ts` (one `runCorpusOnce` factory per node)
- Create: `scripts/template-validation/refreshReport.ts`
- Modify: `scripts/node-sweep.ts` (`parseArgs`: `--corpus template` → template mode; `--node` accepts any of the 12; `main()` branch)
- Modify: `package.json` (`"sweep:template": "tsx --env-file=.env scripts/node-sweep.ts --corpus template"`)
- Test: `tests/scripts/templateValidation/runners.test.ts`, `tests/scripts/templateValidation/refreshReport.test.ts`, `tests/scripts/nodeSweep.test.ts`

**Interfaces:**
- Consumes: `runSweep`, `SweepConfig`, `CorpusRunResult`, `PerEntry` (existing); Tasks 4–6 and 10; `judgeSingleResult`'s model via `getJudgeModel()` for the `scoreRubric` judge.
- Produces:
  ```ts
  export interface TemplateEnv { apiKey: string; tables: TableContext[]; knowledge: KnowledgeSummary[]; execute: (sql: string) => Promise<QueryResultLike | Error>; judge: (text: string, fact: string) => Promise<boolean> }
  export function loadTemplateEnv(apiKey: string): Promise<TemplateEnv>; // tables from TV dbt artifacts; knowledge ONLY from TV knowledge dir; ignores FILE_SEARCH_STORE_ID
  export function createTemplateRunner(node: NodeId, items: unknown[], env: TemplateEnv): () => Promise<CorpusRunResult>;
  export async function verifyCrossPass(sqlRunner: () => Promise<CorpusRunResult>, picks: { sqlGenerator?: SweepProfile; supervisor?: SweepProfile }, baselineMetric: number, eps: number): Promise<{ revertSupervisor: boolean; metric: number }>;
  export interface RefreshRow { node: NodeId; current: string; recommended: string; currentMetric: number; recommendedMetric: number; eps: number; signal: 'strong'|'medium'|'weak'; costDelta: number; p95Ms: number; applicable: boolean; flatAtFloor: boolean; quorumMemberWinner: boolean }
  export function buildRefreshRows(outcomes: NodeOutcome[], epsByNode: Map<NodeId, number>, provenance: Provenance): RefreshRow[];
  export function renderRefreshReport(rows: RefreshRow[], meta: { setVersion: string; setHash: string; date: string; provenance: Provenance }): string;
  ```
  PerEntry mapping (plan): `clarification` → `clarificationPassed = (result.confidence==='low') === item.expectedSuspend`. `sqlGenerator` → `qualityLoop` with `supervisor` at its default and **clarification bypassed** (spec amendment 6); then candidate SQL passes `validateSql` (L1–L4), and **both** the item's `referenceSql` and the candidate are executed at sweep time (thelook data drifts, so stored results are never used); `sqlGenMetric = overallScore = resultsEquivalent(ref, cand, { ordered: referenceIsOrdered(referenceSql) }) ? 1 : 0`. A validation failure scores 0. Every other node → `overallScore = sqlGenMetric = itemScore`. So `runSweep`'s metric and e2e axes are both the deterministic score, and **no judge runs** except inside `scoreRubric`. Node calls go through the real agent functions (`classifyAmbiguity`, `reviewSql` (PASS/FAIL vs `expectedVerdict`), `handleDbtStatus`, `generateChartSpec`, `summarizeResults`, `handleMetaQuestion`, `generateDiagnosticSql` (diagnostic must pass `validateSql` and execute, ×0.5, plus `scoreRubric` ×0.5 over `[item.defect, ...item.rubric]`, so the judge checks that the seeded defect is named), `generateTeachingCandidate`, `classifySlackIntake`, `classifyFollowUp`), under `withUsageSink` so `nodeUsage` is filled.
  Flags (plan): `flatAtFloor` = (max−min of the stage-1+2 metrics ≤ ε) ∧ max < 0.9. `applicable` = ε ≤ 0.05 ∧ ¬flatAtFloor ∧ recommended ≠ current. `quorumMemberWinner` = the recommended model id appears in any member's `reportedModels` or `requestedModel`. `signal` per the spec's table (strong: the 5 closed-set nodes + sqlGenerator + supervisor; medium: dbtStatus, chart, summaryOverride; weak: metaQuestion, discrepancy). The report starts with a warning banner when `provenance.singleFamily || provenance.reducedQuorum`. Output: `benchmarks/results/<date>-model-refresh.md` + `.json`. `meta.setHash` comes from `hashValidationSet()` (Task 6) and `meta.setVersion` from `VERSION`.
  Order in `main()`: every non-SQL node (one `runSweep` each), then `sqlGenerator`, then `supervisor` (isolated on its own items), then `verifyCrossPass`.

- [ ] **Step 1: Failing tests:**
  - `template mode ignores FILE_SEARCH_STORE_ID and repo knowledge`: with env `FILE_SEARCH_STORE_ID=x`, `loadTemplateEnv` returns knowledge whose sources are all under `benchmarks/template-validation/knowledge`, and runners never pass a store id (spy on `qualityLoop` options).
  - `clarification runner scores suspend match`; `sqlGenerator runner scores equivalence, never calls the judge`; `supervisor runner scores verdict match`.
  - `verifyCrossPass reverts supervisor when metric drops more than eps`.
  - `buildRefreshRows marks flat-at-floor not applicable` (metrics 0.30/0.31, ε 0.02); `marks quorumMemberWinner`; `renderRefreshReport shows reduced-quorum banner`.
  - `parseArgs accepts --corpus template with any node id`.
  - `sqlGenerator runner bypasses clarification and executes the reference at sweep time` (spy: `executeQuery` called with `referenceSql` on every run).
  - `renderRefreshReport prints eps and set hash for every row`.
- [ ] **Step 2: Run** `npx vitest run tests/scripts/templateValidation tests/scripts/nodeSweep.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sweep): template-mode sizing for all 12 nodes + local refresh report`.

### Task 12: Rule, runbook, and governance docs

**Files:**
- Create: `docs/model-refresh.md` (the runbook from spec §7, with the real npm script names: `model:discover`, `tv:setup`, `tv:label`, `sweep:template`)
- Modify: `README.md` (link the runbook next to the node-sizing docs)
- Modify: `src/agents/CLAUDE.md` (spec §6: install-invariant nodes measured on the set → `MEASURED`; install-coupled nodes `clarification`, `sqlGenerator`, `supervisor`, `discrepancy`, `dbtStatus`, `teachingCandidate` → `TEMPLATE-MEASURED (starting point)`, with installs still expected to override; flat-at-floor and vacuous-ε traps still block a change; each `DEFAULTS` comment cites the set version + date)
- Modify: `src/agents/nodeProfiles.ts` (comment-only: describe the tag vocabulary `MEASURED | TEMPLATE-MEASURED | PROVISIONAL`)
- Modify: `docs/trajectory-governance.md`: amend **Current Decision #2** (the scaffolding freeze/ordering) and reorder T3 so "model refresh via template validation set" activates now, with the rationale "pinned Gemini 3.x preview defaults are obsolete (live list 2026-11-18 offers 3.5–3.8 Flash, Gemini 4); obsolescence is recurring". Update the Node-sizing row and the Deferred Work "New evaluation/benchmark/sizing scaffolding" row, and add an Evidence Log entry.
- Modify: root `CLAUDE.md` Commands section (add the four scripts).
- Test: `tests/infra/` is unaffected; run the full suite.

- [ ] **Step 1: Write the docs** above.
- [ ] **Step 2: Run** `npm run typecheck && npm test`. Expected: PASS. Run `grep -n "listGemini3xModels" -r src scripts docs/model-refresh.md src/agents/CLAUDE.md`. Expected: no hits.
- [ ] **Step 3: Commit** `docs: model refresh runbook, TEMPLATE-MEASURED rule, governance reorder`.

### Task 13: Execute refresh v1 (operator run — needs the human present)

Live, billed step. Pause for confirmation before Steps 3 and 5.

- [ ] **Step 1:** `npm run model:discover`. Register the chosen new text models (`status: 'candidate'`, prices from the pricing page, probed thinking levels). Commit `feat: register <models>`.
- [ ] **Step 2:** `npm run tv:setup`. Expected: 7 views; artifacts unchanged or regenerated without project IDs.
- [ ] **Step 3 (confirm first):** `npm run tv:label`. Expected: `provenance.json` with `quorumKind: 'full'`, accepted counts near the targets, quarantine files written. Review a sample of 10 accepted items per node by eye. Commit the set: `feat(tv): validation set tv-v1`.
- [ ] **Step 4 (confirm first):** `npm run sweep:template`. Expected: `benchmarks/results/<date>-model-refresh.md` (not committed).
- [ ] **Step 5:** With the human, apply the `applicable` rows to `DEFAULTS` (tag `MEASURED tv-v1 <date>` or `TEMPLATE-MEASURED tv-v1 <date>`). Update `DEFAULT_FLASH_MODEL`/`DEFAULT_PRO_MODEL` and `.env.example`. Mark superseded entries `retired` once nothing references them. Run `npm run typecheck && npm test` (PASS). Commit `feat: refresh node defaults from tv-v1`.
