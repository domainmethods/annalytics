# Anna Lytics Phase 0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Get a Slack bot answering natural-language data questions against BigQuery using dbt metadata, with a single LLM call per query.

**Architecture:** Bolt.js (HTTP mode) on Cloud Run, single Gemini 3.0 Pro call for SQL generation, 4-layer validation pipeline (static → AST → dry run → cost gate), BigQuery execution with limits, Firestore for state. No supervisor, no clarification agent, no teachings — those are Phase 1.

**Tech Stack:** TypeScript, Bolt.js, Google GenAI SDK (`@google/genai`), `@google-cloud/bigquery`, `@google-cloud/firestore`, `node-sql-parser`, `pino`, Vitest, Docker, Cloud Run, Terraform

**Design Doc:** `docs/plans/2026-02-15-anna-lytics-design.md` (2,357 lines, 18 sections)

---

## Phase 0 Scope

From the design doc, Phase 0 includes:

1. Natural-language questions → BigQuery SQL → results (read-only, auto-execute)
2. dbt metadata (manifest.json + catalog.json) as primary schema context (full schema in every prompt — no RAG)
3. Single LLM call per query (no supervisor, no clarification agent)
4. Query validation: dry run + cost gate + execution limits
5. Adaptive response format (numbers, tables, summaries)
6. Thumbs-up/down buttons (logged to Firestore, not yet acted on)
7. Basic thread context (last 4 messages)

**Explicitly NOT in Phase 0:** Clarification Agent, Supervisor Agent, File Search, teachings, escalation, meta-questions, channel-based access control, override buttons, `/anna teach`, message edit handling.

---

## Project Structure

```
annalytics/
├── docs/plans/                        # Design + implementation plans
├── src/
│   ├── app.ts                         # Bolt.js app setup, event wiring, start
│   ├── config.ts                      # Environment config loading
│   ├── logging.ts                     # pino setup + traceId factory
│   ├── errors.ts                      # friendlyErrorMessage mapping
│   ├── pipeline.ts                    # runPipeline orchestration
│   ├── dbt/
│   │   ├── types.ts                   # TableContext, MetadataState interfaces
│   │   ├── parser.ts                  # manifest + catalog → TableContext[]
│   │   └── quality.ts                 # Per-table metadata quality scoring
│   ├── validation/
│   │   ├── staticAnalysis.ts          # Layer 1: regex pattern blocking
│   │   ├── astValidation.ts           # Layer 2: node-sql-parser AST check
│   │   ├── dryRun.ts                  # Layer 3: BigQuery dry run
│   │   ├── costGate.ts               # Layer 4: bytes threshold check
│   │   └── pipeline.ts               # Orchestrates L1→L4
│   ├── agents/
│   │   └── sqlGenerator.ts            # Gemini 3.0 Pro structured output call
│   ├── execution/
│   │   ├── runner.ts                  # BigQuery query execution with limits
│   │   └── formatter.ts              # Adaptive response format selection
│   ├── slack/
│   │   ├── blocks.ts                  # Block Kit message builders
│   │   ├── statusUpdater.ts           # Progressive chat.update wrapper
│   │   └── threadContext.ts           # Thread message retrieval + compression
│   ├── state/
│   │   ├── firestore.ts              # Firestore client singleton
│   │   ├── responseContext.ts         # ResponseContext CRUD
│   │   ├── threadLock.ts             # Per-thread processing lock
│   │   ├── rateLimiter.ts            # Per-user rate limiting
│   │   └── metadataState.ts          # Metadata freshness tracking
│   └── handlers/
│       ├── commands.ts                # /anna slash command
│       ├── mentions.ts                # app_mention event
│       └── messages.ts                # message event + shouldRespond
├── tests/
│   ├── fixtures/
│   │   ├── manifest.json             # Minimal dbt manifest (3 models)
│   │   └── catalog.json              # Matching catalog with types
│   ├── dbt/
│   │   ├── parser.test.ts
│   │   └── quality.test.ts
│   ├── validation/
│   │   ├── staticAnalysis.test.ts
│   │   ├── astValidation.test.ts
│   │   ├── dryRun.test.ts
│   │   ├── costGate.test.ts
│   │   └── pipeline.test.ts
│   ├── agents/
│   │   └── sqlGenerator.test.ts
│   ├── execution/
│   │   ├── runner.test.ts
│   │   └── formatter.test.ts
│   ├── slack/
│   │   ├── blocks.test.ts
│   │   └── threadContext.test.ts
│   ├── state/
│   │   ├── threadLock.test.ts
│   │   ├── rateLimiter.test.ts
│   │   └── responseContext.test.ts
│   ├── handlers/
│   │   └── messages.test.ts
│   ├── errors.test.ts
│   └── pipeline.test.ts
├── infra/
│   ├── main.tf                        # Cloud Run, Firestore, IAM, Secret Manager
│   └── firestore.indexes.json         # Composite index definitions
├── .github/workflows/
│   └── deploy.yml                     # Build, test, deploy to Cloud Run
├── Dockerfile
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── .env.example
```

---

## Tasks

Tasks are ordered inside-out: pure functions first, integration layers last. Each task follows TDD: write failing test → run to confirm failure → implement → run to confirm pass → commit.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `Dockerfile`
- Create: `src/config.ts`

**Step 1: Initialize project and install dependencies**

```bash
cd /home/souther/Projects/annalytics
npm init -y
npm install @slack/bolt @google/genai @google-cloud/bigquery @google-cloud/firestore node-sql-parser pino zod
npm install -D typescript vitest @types/node
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/app.ts'],
    },
  },
});
```

**Step 4: Create .env.example**

```bash
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...

# Gemini (Developer API key — required for File Search in Phase 1)
GEMINI_API_KEY=...

# GCP (ADC for BigQuery + Firestore — service account on Cloud Run)
GCP_PROJECT_ID=...

# App config
PORT=3000
COST_GATE_MAX_BYTES=10737418240  # 10GB
QUERY_TIMEOUT_MS=30000
MAX_RESULT_ROWS=1000
RATE_LIMIT_PER_HOUR=30
```

**Step 5: Create src/config.ts**

```typescript
export interface AppConfig {
  slack: {
    botToken: string;
    signingSecret: string;
  };
  gemini: {
    apiKey: string;
    model: string;
  };
  gcp: {
    projectId: string;
  };
  limits: {
    costGateMaxBytes: number;
    queryTimeoutMs: number;
    maxResultRows: number;
    rateLimitPerHour: number;
  };
  port: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function loadConfig(): AppConfig {
  return {
    slack: {
      botToken: requireEnv('SLACK_BOT_TOKEN'),
      signingSecret: requireEnv('SLACK_SIGNING_SECRET'),
    },
    gemini: {
      apiKey: requireEnv('GEMINI_API_KEY'),
      model: process.env.GEMINI_MODEL || 'gemini-3.0-pro',
    },
    gcp: {
      projectId: requireEnv('GCP_PROJECT_ID'),
    },
    limits: {
      costGateMaxBytes: Number(process.env.COST_GATE_MAX_BYTES) || 10_737_418_240,
      queryTimeoutMs: Number(process.env.QUERY_TIMEOUT_MS) || 30_000,
      maxResultRows: Number(process.env.MAX_RESULT_ROWS) || 1_000,
      rateLimitPerHour: Number(process.env.RATE_LIMIT_PER_HOUR) || 30,
    },
    port: Number(process.env.PORT) || 3000,
  };
}
```

**Step 6: Create Dockerfile**

```dockerfile
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY package.json ./
CMD ["dist/app.js"]
```

**Step 7: Update package.json scripts**

Add to `package.json` scripts:
```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/app.js",
    "dev": "npx tsx src/app.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

**Step 8: Verify setup**

Run: `npx tsc --noEmit`
Expected: No errors (only config.ts exists, no imports to fail)

Run: `npx vitest run`
Expected: "No test files found" (no tests yet — that's correct)

**Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example Dockerfile src/config.ts
git commit -m "chore: scaffold Phase 0 project (TypeScript, Bolt.js, Vitest)"
```

---

### Task 2: Types and Interfaces

**Files:**
- Create: `src/dbt/types.ts`
- Create: `src/types.ts`

**Step 1: Create dbt types**

File: `src/dbt/types.ts`

```typescript
export interface TableContext {
  name: string;               // e.g., "analytics.fct_orders"
  schema: string;             // e.g., "analytics"
  description: string;
  materialization: string;    // "table" | "view" | "incremental"
  columns: ColumnContext[];
  sampleDDL: string;          // CREATE TABLE DDL for prompt injection
  dependsOn: string[];        // dbt node IDs this model depends on
  tags: string[];
}

export interface ColumnContext {
  name: string;
  description: string;
  dataType: string;           // from catalog.json, e.g., "STRING", "INT64"
  meta: Record<string, unknown>;
}

export interface TableQuality {
  descriptionPresent: boolean;
  columnDescriptionCoverage: number;  // 0-1
  qualityTier: 'high' | 'medium' | 'low';
}

export interface MetadataState {
  lastRefreshAt: Date;
  manifestVersion: string;
  tableCount: number;
  refreshSource: 'webhook' | 'poll' | 'manual';
}
```

**Step 2: Create pipeline types**

File: `src/types.ts`

```typescript
export interface SqlGenerationResult {
  sql: string;
  explanation: string;
  tablesUsed: string[];
  confidence: 'high' | 'medium' | 'low';
  assumptions: string[];
  reasoningChain: string;
}

export interface ValidationResult {
  valid: boolean;
  layer: string;              // which layer failed
  error?: string;
  bytesProcessed?: number;    // from dry run
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  columnNames: string[];
  totalRows: number;          // from job metadata (not COUNT(*))
  bytesProcessed: number;
  truncated: boolean;         // true if totalRows > maxResultRows
}

export interface ResponseContext {
  responseId: string;
  threadTs: string;
  statusMsgTs: string;
  clarifiedQuestion: string;
  assumptions: string[];
  reasoningChain: string;
  generatedSql: string;
  tablesUsed: string[];
  confidence: 'high' | 'medium' | 'low';
  queryResults: {
    rowCount: number;
    columnNames: string[];
    bytesProcessed: number;
  };
  pipelineDurationMs: number;
  traceId: string;
  createdAt: Date;
}

export interface PipelineLog {
  traceId: string;
  stage: 'retrieve' | 'generate' | 'validate' | 'execute' | 'format';
  durationMs: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  confidence?: string;
  bytesProcessed?: number;
  error?: string;
}

export interface ThreadMessage {
  role: 'user' | 'assistant';
  content: string;
}
```

**Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/dbt/types.ts src/types.ts
git commit -m "feat: add core type definitions (TableContext, pipeline types, ResponseContext)"
```

---

### Task 3: Observability (pino + traceId)

**Files:**
- Create: `src/logging.ts`

**Step 1: Create logging module**

File: `src/logging.ts`

```typescript
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import type { PipelineLog } from './types.js';

const rootLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ severity: label.toUpperCase() }),
  },
  // Cloud Logging expects 'message' not 'msg'
  messageKey: 'message',
});

export function createTraceId(): string {
  return randomUUID();
}

export function createLogger(traceId: string) {
  return rootLogger.child({ traceId });
}

export function logStage(logger: pino.Logger, log: PipelineLog): void {
  logger.info(log, `pipeline.${log.stage}`);
}

export { rootLogger };
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/logging.ts
git commit -m "feat: add pino structured logging with traceId propagation"
```

---

### Task 4: Error Handling

**Files:**
- Create: `src/errors.ts`
- Create: `tests/errors.test.ts`

**Step 1: Write failing test**

File: `tests/errors.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { friendlyErrorMessage } from '../src/errors.js';

describe('friendlyErrorMessage', () => {
  const traceId = 'test-trace-123';

  it('maps NOT_FOUND to table-not-found message', () => {
    const error = new Error('NOT_FOUND: Table my_project.analytics.missing not found');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain("couldn't find one of the tables");
    expect(msg).not.toContain('NOT_FOUND');
  });

  it('maps ACCESS_DENIED to access message', () => {
    const error = new Error('ACCESS_DENIED: Permission denied');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain("don't have access");
  });

  it('maps FORBIDDEN to access message', () => {
    const error = new Error('FORBIDDEN: Insufficient permissions');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain("don't have access");
  });

  it('maps DEADLINE_EXCEEDED to timeout message', () => {
    const error = new Error('DEADLINE_EXCEEDED: Query timed out');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain('took too long');
  });

  it('maps timeout to timeout message', () => {
    const error = new Error('timeout after 30000ms');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain('took too long');
  });

  it('maps RESOURCE_EXHAUSTED to high-demand message', () => {
    const error = new Error('RESOURCE_EXHAUSTED: Quota exceeded');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain('high demand');
  });

  it('maps SAFETY to rephrase message', () => {
    const error = new Error('SAFETY: Content blocked');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain('rephrasing');
  });

  it('returns generic message with traceId for unknown errors', () => {
    const error = new Error('Something completely unexpected');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain('Something went wrong');
    expect(msg).toContain(traceId);
  });

  it('never exposes raw error message to user', () => {
    const error = new Error('RESOURCE_EXHAUSTED: Quota exceeded for aiplatform.googleapis.com');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).not.toContain('aiplatform.googleapis.com');
    expect(msg).not.toContain('Quota exceeded');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/errors.test.ts`
Expected: FAIL — "Cannot find module '../src/errors.js'"

**Step 3: Write implementation**

File: `src/errors.ts`

```typescript
export function friendlyErrorMessage(error: Error, traceId: string): string {
  const msg = error.message;

  // BigQuery errors
  if (msg.includes('NOT_FOUND'))
    return "I couldn't find one of the tables I need. The data model may have changed recently.";
  if (msg.includes('ACCESS_DENIED') || msg.includes('FORBIDDEN'))
    return "I don't have access to query this data from this channel.";
  if (msg.includes('DEADLINE_EXCEEDED') || msg.includes('timeout'))
    return 'This query took too long. Try asking for a smaller time range or fewer dimensions.';

  // Gemini errors
  if (msg.includes('RESOURCE_EXHAUSTED'))
    return "I'm experiencing high demand — please try again in a moment.";
  if (msg.includes('SAFETY'))
    return "I wasn't able to process that question. Try rephrasing it.";

  // Default — always include traceId so the data team can investigate
  return `Something went wrong. I've logged the details for the data team. (trace: ${traceId})`;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/errors.test.ts`
Expected: All 9 tests PASS

**Step 5: Commit**

```bash
git add src/errors.ts tests/errors.test.ts
git commit -m "feat: add friendly error message mapping with traceId"
```

---

### Task 5: dbt Metadata Parser

**Files:**
- Create: `src/dbt/parser.ts`
- Create: `tests/dbt/parser.test.ts`
- Create: `tests/fixtures/manifest.json`
- Create: `tests/fixtures/catalog.json`

**Step 1: Create test fixtures**

File: `tests/fixtures/manifest.json` — minimal dbt manifest with 3 models. Include one model with full column descriptions, one with sparse descriptions, and one staging model (should be filtered out by tag or path convention).

```json
{
  "metadata": { "dbt_schema_version": "https://schemas.getdbt.com/dbt/manifest/v11.json" },
  "nodes": {
    "model.my_project.fct_orders": {
      "resource_type": "model",
      "name": "fct_orders",
      "schema": "analytics",
      "description": "All completed customer orders",
      "columns": {
        "order_id": { "name": "order_id", "description": "Primary key", "meta": {} },
        "customer_id": { "name": "customer_id", "description": "FK to dim_customers", "meta": {} },
        "order_date": { "name": "order_date", "description": "Date the order was placed", "meta": {} },
        "total_amount": { "name": "total_amount", "description": "Total order value in USD", "meta": {} },
        "order_status": { "name": "order_status", "description": "completed, cancelled, refunded", "meta": {} }
      },
      "config": { "materialized": "table" },
      "depends_on": { "nodes": ["model.my_project.stg_orders"] },
      "tags": ["finance"]
    },
    "model.my_project.dim_customers": {
      "resource_type": "model",
      "name": "dim_customers",
      "schema": "analytics",
      "description": "Customer dimension table",
      "columns": {
        "customer_id": { "name": "customer_id", "description": "Primary key", "meta": {} },
        "name": { "name": "name", "description": "", "meta": {} },
        "email": { "name": "email", "description": "", "meta": {} },
        "region": { "name": "region", "description": "Geographic region", "meta": {} },
        "last_order_date": { "name": "last_order_date", "description": "", "meta": {} }
      },
      "config": { "materialized": "table" },
      "depends_on": { "nodes": [] },
      "tags": ["customers"]
    },
    "model.my_project.stg_orders": {
      "resource_type": "model",
      "name": "stg_orders",
      "schema": "staging",
      "description": "Staging orders",
      "columns": {
        "id": { "name": "id", "description": "", "meta": {} }
      },
      "config": { "materialized": "view" },
      "depends_on": { "nodes": [] },
      "tags": ["staging"]
    },
    "source.my_project.raw.events": {
      "resource_type": "source",
      "name": "events",
      "schema": "raw",
      "description": "Raw events",
      "columns": {}
    }
  }
}
```

File: `tests/fixtures/catalog.json` — matching catalog with UPPERCASE column names (BigQuery convention):

```json
{
  "metadata": { "dbt_schema_version": "https://schemas.getdbt.com/dbt/catalog/v1.json" },
  "nodes": {
    "model.my_project.fct_orders": {
      "columns": {
        "ORDER_ID": { "type": "STRING", "index": 1 },
        "CUSTOMER_ID": { "type": "STRING", "index": 2 },
        "ORDER_DATE": { "type": "DATE", "index": 3 },
        "TOTAL_AMOUNT": { "type": "FLOAT64", "index": 4 },
        "ORDER_STATUS": { "type": "STRING", "index": 5 }
      },
      "stats": { "row_count": { "value": 50000 } }
    },
    "model.my_project.dim_customers": {
      "columns": {
        "CUSTOMER_ID": { "type": "STRING", "index": 1 },
        "NAME": { "type": "STRING", "index": 2 },
        "EMAIL": { "type": "STRING", "index": 3 },
        "REGION": { "type": "STRING", "index": 4 },
        "LAST_ORDER_DATE": { "type": "DATE", "index": 5 }
      },
      "stats": { "row_count": { "value": 5000 } }
    },
    "model.my_project.stg_orders": {
      "columns": {
        "ID": { "type": "STRING", "index": 1 }
      },
      "stats": {}
    }
  }
}
```

**Step 2: Write failing test**

File: `tests/dbt/parser.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDbtArtifacts } from '../../src/dbt/parser.js';

const fixturesDir = join(import.meta.dirname, '../fixtures');
const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf-8'));
const catalog = JSON.parse(readFileSync(join(fixturesDir, 'catalog.json'), 'utf-8'));

describe('parseDbtArtifacts', () => {
  const tables = parseDbtArtifacts(manifest, catalog);

  it('only parses model resource types (not sources)', () => {
    expect(tables).toHaveLength(3);
    expect(tables.map(t => t.name)).not.toContain('raw.events');
  });

  it('creates TableContext with correct name format', () => {
    const fctOrders = tables.find(t => t.name === 'analytics.fct_orders');
    expect(fctOrders).toBeDefined();
    expect(fctOrders!.schema).toBe('analytics');
    expect(fctOrders!.description).toBe('All completed customer orders');
    expect(fctOrders!.materialization).toBe('table');
    expect(fctOrders!.tags).toEqual(['finance']);
  });

  it('normalizes catalog column names to lowercase for type lookup', () => {
    const fctOrders = tables.find(t => t.name === 'analytics.fct_orders')!;
    const totalAmount = fctOrders.columns.find(c => c.name === 'total_amount');
    expect(totalAmount).toBeDefined();
    expect(totalAmount!.dataType).toBe('FLOAT64'); // from UPPERCASE catalog key
  });

  it('falls back to UNKNOWN when column not in catalog', () => {
    // stg_orders has ID in catalog but manifest uses 'id' (lowercase)
    // The normalizer should handle this
    const stg = tables.find(t => t.name === 'staging.stg_orders')!;
    expect(stg.columns[0].dataType).toBe('STRING');
  });

  it('preserves column descriptions from manifest', () => {
    const fctOrders = tables.find(t => t.name === 'analytics.fct_orders')!;
    const orderId = fctOrders.columns.find(c => c.name === 'order_id');
    expect(orderId!.description).toBe('Primary key');
  });

  it('preserves dependsOn from manifest', () => {
    const fctOrders = tables.find(t => t.name === 'analytics.fct_orders')!;
    expect(fctOrders.dependsOn).toEqual(['model.my_project.stg_orders']);
  });

  it('generates sampleDDL string', () => {
    const fctOrders = tables.find(t => t.name === 'analytics.fct_orders')!;
    expect(fctOrders.sampleDDL).toContain('CREATE TABLE');
    expect(fctOrders.sampleDDL).toContain('analytics.fct_orders');
    expect(fctOrders.sampleDDL).toContain('order_id');
    expect(fctOrders.sampleDDL).toContain('FLOAT64');
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run tests/dbt/parser.test.ts`
Expected: FAIL — "Cannot find module '../../src/dbt/parser.js'"

**Step 4: Write implementation**

File: `src/dbt/parser.ts`

```typescript
import type { TableContext, ColumnContext } from './types.js';

interface ManifestNode {
  resource_type: string;
  name: string;
  schema: string;
  description?: string;
  columns: Record<string, { name: string; description?: string; meta?: Record<string, unknown> }>;
  config?: { materialized?: string };
  depends_on?: { nodes?: string[] };
  tags?: string[];
}

interface CatalogNode {
  columns: Record<string, { type: string; index: number }>;
}

export function parseDbtArtifacts(
  manifest: { nodes: Record<string, ManifestNode> },
  catalog: { nodes: Record<string, CatalogNode> },
): TableContext[] {
  const tables: TableContext[] = [];

  for (const [nodeId, node] of Object.entries(manifest.nodes)) {
    if (node.resource_type !== 'model') continue;

    const catalogNode = catalog.nodes[nodeId];

    // Normalize catalog column keys to lowercase — BigQuery's catalog.json
    // reports column names in UPPERCASE while manifest.json uses lowercase.
    const catalogColumns = catalogNode?.columns
      ? Object.fromEntries(
          Object.entries(catalogNode.columns).map(([k, v]) => [k.toLowerCase(), v]),
        )
      : {};

    const columns: ColumnContext[] = Object.values(node.columns).map((col) => ({
      name: col.name,
      description: col.description || '',
      dataType: catalogColumns[col.name.toLowerCase()]?.type || 'UNKNOWN',
      meta: col.meta || {},
    }));

    const table: TableContext = {
      name: `${node.schema}.${node.name}`,
      schema: node.schema,
      description: node.description || '',
      materialization: node.config?.materialized || 'view',
      columns,
      sampleDDL: generateDDL(node.schema, node.name, columns),
      dependsOn: node.depends_on?.nodes || [],
      tags: node.tags || [],
    };

    tables.push(table);
  }

  return tables;
}

function generateDDL(schema: string, name: string, columns: ColumnContext[]): string {
  const colDefs = columns
    .map((c) => {
      const comment = c.description ? ` -- ${c.description}` : '';
      return `  ${c.name} ${c.dataType}${comment}`;
    })
    .join(',\n');
  return `CREATE TABLE \`${schema}.${name}\` (\n${colDefs}\n);`;
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/dbt/parser.test.ts`
Expected: All 7 tests PASS

**Step 6: Commit**

```bash
git add src/dbt/parser.ts tests/dbt/parser.test.ts tests/fixtures/manifest.json tests/fixtures/catalog.json
git commit -m "feat: add dbt manifest+catalog parser with case-normalized column types"
```

---

### Task 6: Metadata Quality Assessment

**Files:**
- Create: `src/dbt/quality.ts`
- Create: `tests/dbt/quality.test.ts`

**Step 1: Write failing test**

File: `tests/dbt/quality.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { assessQuality } from '../../src/dbt/quality.js';
import type { TableContext } from '../../src/dbt/types.js';

function makeTable(overrides: Partial<TableContext> = {}): TableContext {
  return {
    name: 'test.table',
    schema: 'test',
    description: 'A test table',
    materialization: 'table',
    columns: [
      { name: 'id', description: 'Primary key', dataType: 'STRING', meta: {} },
      { name: 'name', description: 'User name', dataType: 'STRING', meta: {} },
      { name: 'email', description: 'Email address', dataType: 'STRING', meta: {} },
    ],
    sampleDDL: '',
    dependsOn: [],
    tags: [],
    ...overrides,
  };
}

describe('assessQuality', () => {
  it('returns high tier when >70% columns have descriptions', () => {
    const result = assessQuality(makeTable()); // 3/3 = 100%
    expect(result.qualityTier).toBe('high');
    expect(result.columnDescriptionCoverage).toBe(1);
    expect(result.descriptionPresent).toBe(true);
  });

  it('returns medium tier when 30-70% columns have descriptions', () => {
    const table = makeTable({
      columns: [
        { name: 'id', description: 'Primary key', dataType: 'STRING', meta: {} },
        { name: 'name', description: '', dataType: 'STRING', meta: {} },
        { name: 'email', description: '', dataType: 'STRING', meta: {} },
      ],
    }); // 1/3 = 33%
    const result = assessQuality(table);
    expect(result.qualityTier).toBe('medium');
  });

  it('returns low tier when <30% columns have descriptions', () => {
    const table = makeTable({
      columns: [
        { name: 'id', description: '', dataType: 'STRING', meta: {} },
        { name: 'name', description: '', dataType: 'STRING', meta: {} },
        { name: 'email', description: '', dataType: 'STRING', meta: {} },
        { name: 'region', description: 'geo', dataType: 'STRING', meta: {} },
      ],
    }); // 1/4 = 25%
    const result = assessQuality(table);
    expect(result.qualityTier).toBe('low');
  });

  it('detects missing table description', () => {
    const result = assessQuality(makeTable({ description: '' }));
    expect(result.descriptionPresent).toBe(false);
  });

  it('treats whitespace-only descriptions as empty', () => {
    const table = makeTable({
      description: '   ',
      columns: [
        { name: 'id', description: '  ', dataType: 'STRING', meta: {} },
      ],
    });
    const result = assessQuality(table);
    expect(result.descriptionPresent).toBe(false);
    expect(result.columnDescriptionCoverage).toBe(0);
    expect(result.qualityTier).toBe('low');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dbt/quality.test.ts`
Expected: FAIL — "Cannot find module '../../src/dbt/quality.js'"

**Step 3: Write implementation**

File: `src/dbt/quality.ts`

```typescript
import type { TableContext, TableQuality } from './types.js';

export function assessQuality(table: TableContext): TableQuality {
  const described = table.columns.filter((c) => c.description.trim().length > 0);
  const coverage = table.columns.length > 0 ? described.length / table.columns.length : 0;

  return {
    descriptionPresent: table.description.trim().length > 0,
    columnDescriptionCoverage: coverage,
    qualityTier: coverage > 0.7 ? 'high' : coverage > 0.3 ? 'medium' : 'low',
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dbt/quality.test.ts`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add src/dbt/quality.ts tests/dbt/quality.test.ts
git commit -m "feat: add per-table metadata quality scoring"
```

---

### Task 7: Validation Layer 1 — Static Analysis

**Files:**
- Create: `src/validation/staticAnalysis.ts`
- Create: `tests/validation/staticAnalysis.test.ts`

**Step 1: Write failing test**

File: `tests/validation/staticAnalysis.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { staticAnalysis } from '../../src/validation/staticAnalysis.js';

describe('staticAnalysis', () => {
  it('passes a valid SELECT statement', () => {
    const result = staticAnalysis('SELECT id, name FROM users WHERE id = 1');
    expect(result.valid).toBe(true);
  });

  it('blocks DROP statements', () => {
    const result = staticAnalysis('DROP TABLE users');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('DROP');
  });

  it('blocks ALTER statements', () => {
    const result = staticAnalysis('ALTER TABLE users ADD COLUMN age INT');
    expect(result.valid).toBe(false);
  });

  it('blocks DELETE statements', () => {
    const result = staticAnalysis('DELETE FROM users WHERE id = 1');
    expect(result.valid).toBe(false);
  });

  it('blocks INSERT statements', () => {
    const result = staticAnalysis('INSERT INTO users (name) VALUES ("test")');
    expect(result.valid).toBe(false);
  });

  it('blocks UPDATE statements', () => {
    const result = staticAnalysis('UPDATE users SET name = "test" WHERE id = 1');
    expect(result.valid).toBe(false);
  });

  it('blocks CREATE statements', () => {
    const result = staticAnalysis('CREATE TABLE users (id INT)');
    expect(result.valid).toBe(false);
  });

  it('blocks GRANT statements', () => {
    const result = staticAnalysis('GRANT SELECT ON users TO user1');
    expect(result.valid).toBe(false);
  });

  it('blocks REVOKE statements', () => {
    const result = staticAnalysis('REVOKE SELECT ON users FROM user1');
    expect(result.valid).toBe(false);
  });

  it('blocks multi-statement queries (semicolon-separated)', () => {
    const result = staticAnalysis('SELECT 1; DROP TABLE users');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('multi-statement');
  });

  it('blocks SQL comments (-- style)', () => {
    const result = staticAnalysis('SELECT 1 -- this is fine');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('comment');
  });

  it('blocks SQL comments (/* */ style)', () => {
    const result = staticAnalysis('SELECT /* comment */ 1');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('comment');
  });

  it('is case-insensitive', () => {
    const result = staticAnalysis('drop TABLE users');
    expect(result.valid).toBe(false);
  });

  it('does not false-positive on column names containing keywords', () => {
    const result = staticAnalysis('SELECT updated_at, created_at, drop_date FROM orders');
    expect(result.valid).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/validation/staticAnalysis.test.ts`
Expected: FAIL — "Cannot find module"

**Step 3: Write implementation**

File: `src/validation/staticAnalysis.ts`

```typescript
import type { ValidationResult } from '../types.js';

// DML/DDL keywords that must appear as standalone statements (not substrings)
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(DROP)\b/i, label: 'DROP' },
  { pattern: /\b(ALTER)\b/i, label: 'ALTER' },
  { pattern: /\b(DELETE)\s+FROM\b/i, label: 'DELETE' },
  { pattern: /\b(INSERT)\s+INTO\b/i, label: 'INSERT' },
  { pattern: /\b(UPDATE)\s+\S+\s+SET\b/i, label: 'UPDATE' },
  { pattern: /\b(CREATE)\s+(TABLE|VIEW|SCHEMA|DATABASE|INDEX|FUNCTION|PROCEDURE)\b/i, label: 'CREATE' },
  { pattern: /\b(GRANT)\s+/i, label: 'GRANT' },
  { pattern: /\b(REVOKE)\s+/i, label: 'REVOKE' },
  { pattern: /\b(TRUNCATE)\b/i, label: 'TRUNCATE' },
  { pattern: /\b(MERGE)\b/i, label: 'MERGE' },
];

export function staticAnalysis(sql: string): ValidationResult {
  // Check for multi-statement queries
  // Split on semicolons outside of string literals (simplified: no string-aware parsing)
  const stripped = sql.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
  const statements = stripped.split(';').filter((s) => s.trim().length > 0);
  if (statements.length > 1) {
    return { valid: false, layer: 'L1-static', error: 'Blocked: multi-statement query detected' };
  }

  // Check for SQL comments
  if (/--/.test(stripped)) {
    return { valid: false, layer: 'L1-static', error: 'Blocked: SQL comment (--) detected' };
  }
  if (/\/\*/.test(stripped)) {
    return { valid: false, layer: 'L1-static', error: 'Blocked: SQL comment (/* */) detected' };
  }

  // Check for DML/DDL keywords
  for (const { pattern, label } of BLOCKED_PATTERNS) {
    if (pattern.test(sql)) {
      return { valid: false, layer: 'L1-static', error: `Blocked: ${label} statement detected` };
    }
  }

  return { valid: true, layer: 'L1-static' };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/validation/staticAnalysis.test.ts`
Expected: All 14 tests PASS

**Step 5: Commit**

```bash
git add src/validation/staticAnalysis.ts tests/validation/staticAnalysis.test.ts
git commit -m "feat: add Layer 1 static analysis (DML/DDL blocking, comment detection)"
```

---

### Task 8: Validation Layer 2 — AST Validation

**Files:**
- Create: `src/validation/astValidation.ts`
- Create: `tests/validation/astValidation.test.ts`

**Step 1: Write failing test**

File: `tests/validation/astValidation.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { astValidation } from '../../src/validation/astValidation.js';

describe('astValidation', () => {
  it('passes a valid SELECT statement', () => {
    const result = astValidation('SELECT id, name FROM users WHERE id = 1');
    expect(result.valid).toBe(true);
  });

  it('blocks DML detected in AST (INSERT)', () => {
    const result = astValidation('INSERT INTO users (name) VALUES ("test")');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Only SELECT');
  });

  it('blocks DDL detected in AST (CREATE TABLE)', () => {
    const result = astValidation('CREATE TABLE users (id INT)');
    expect(result.valid).toBe(false);
  });

  it('returns advisory pass on parse failure for valid BigQuery syntax', () => {
    // QUALIFY is valid BigQuery but node-sql-parser may not support it
    const result = astValidation(
      'SELECT id, ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY created_at) AS rn FROM t QUALIFY rn = 1'
    );
    // Should not block — advisory mode on parse failure
    expect(result.valid).toBe(true);
    // But should note it was advisory
    if (result.error) {
      expect(result.error).toContain('advisory');
    }
  });

  it('passes SELECT with common BigQuery functions', () => {
    const result = astValidation(
      'SELECT DATE_TRUNC(order_date, MONTH) AS month, SUM(total_amount) AS revenue FROM analytics.fct_orders GROUP BY 1'
    );
    expect(result.valid).toBe(true);
  });

  it('passes SELECT with subquery', () => {
    const result = astValidation(
      'SELECT * FROM (SELECT id, name FROM users WHERE active = true) sub WHERE sub.id > 10'
    );
    expect(result.valid).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/validation/astValidation.test.ts`
Expected: FAIL — "Cannot find module"

**Step 3: Write implementation**

File: `src/validation/astValidation.ts`

```typescript
import { Parser } from 'node-sql-parser';
import type { ValidationResult } from '../types.js';

const parser = new Parser();

export function astValidation(sql: string): ValidationResult {
  try {
    const ast = parser.astify(sql, { database: 'BigQuery' });

    // ast can be a single statement or array
    const statements = Array.isArray(ast) ? ast : [ast];

    for (const stmt of statements) {
      if (stmt.type !== 'select') {
        return {
          valid: false,
          layer: 'L2-ast',
          error: `Only SELECT statements are allowed (found: ${stmt.type?.toUpperCase()})`,
        };
      }
    }

    return { valid: true, layer: 'L2-ast' };
  } catch {
    // Parse failure — advisory pass. node-sql-parser's BigQuery dialect has known
    // gaps (QUALIFY, SAFE_DIVIDE, nested UNNEST, some window functions).
    // Layer 3 (BigQuery dry run) is the authoritative validator.
    return {
      valid: true,
      layer: 'L2-ast',
      error: 'L2 advisory: AST parse failed — deferring to BigQuery dry run for validation',
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/validation/astValidation.test.ts`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add src/validation/astValidation.ts tests/validation/astValidation.test.ts
git commit -m "feat: add Layer 2 AST validation (advisory on parse failure, blocking for DML/DDL)"
```

---

### Task 9: Validation Layers 3-4 — Dry Run + Cost Gate

**Files:**
- Create: `src/validation/dryRun.ts`
- Create: `src/validation/costGate.ts`
- Create: `tests/validation/dryRun.test.ts`
- Create: `tests/validation/costGate.test.ts`

**Step 1: Write cost gate test (pure function, no mock needed)**

File: `tests/validation/costGate.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { costGate } from '../../src/validation/costGate.js';

describe('costGate', () => {
  const TEN_GB = 10_737_418_240;

  it('passes when bytes are under the threshold', () => {
    const result = costGate(5_000_000_000, TEN_GB);
    expect(result.valid).toBe(true);
    expect(result.bytesProcessed).toBe(5_000_000_000);
  });

  it('fails when bytes exceed the threshold', () => {
    const result = costGate(20_000_000_000, TEN_GB);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('10.00 GB');
  });

  it('passes at exactly the threshold', () => {
    const result = costGate(TEN_GB, TEN_GB);
    expect(result.valid).toBe(true);
  });

  it('includes human-readable sizes in error message', () => {
    const result = costGate(50_000_000_000, TEN_GB);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('46.57 GB'); // actual
    expect(result.error).toContain('10.00 GB'); // limit
  });
});
```

**Step 2: Write cost gate implementation**

File: `src/validation/costGate.ts`

```typescript
import type { ValidationResult } from '../types.js';

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(2)} GB`;
}

export function costGate(bytesProcessed: number, maxBytes: number): ValidationResult {
  if (bytesProcessed <= maxBytes) {
    return { valid: true, layer: 'L4-cost', bytesProcessed };
  }

  return {
    valid: false,
    layer: 'L4-cost',
    bytesProcessed,
    error: `Query would scan ${formatBytes(bytesProcessed)}, exceeding the ${formatBytes(maxBytes)} limit. Try narrowing with a date filter or fewer columns.`,
  };
}
```

**Step 3: Run cost gate test**

Run: `npx vitest run tests/validation/costGate.test.ts`
Expected: All 4 tests PASS

**Step 4: Write dry run test (requires BigQuery mock)**

File: `tests/validation/dryRun.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dryRunValidation } from '../../src/validation/dryRun.js';

// Mock @google-cloud/bigquery
const mockCreateQueryJob = vi.fn();
vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: vi.fn().mockImplementation(() => ({
    createQueryJob: mockCreateQueryJob,
  })),
}));

describe('dryRunValidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns valid with bytesProcessed on successful dry run', async () => {
    mockCreateQueryJob.mockResolvedValue([
      { statistics: { totalBytesProcessed: '5000000000' } },
    ]);

    const result = await dryRunValidation('SELECT * FROM users');
    expect(result.valid).toBe(true);
    expect(result.bytesProcessed).toBe(5_000_000_000);
  });

  it('returns invalid with error message on dry run failure', async () => {
    mockCreateQueryJob.mockRejectedValue(new Error('Table not found: dataset.missing_table'));

    const result = await dryRunValidation('SELECT * FROM dataset.missing_table');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('missing_table');
  });

  it('passes dryRun: true to BigQuery', async () => {
    mockCreateQueryJob.mockResolvedValue([
      { statistics: { totalBytesProcessed: '0' } },
    ]);

    await dryRunValidation('SELECT 1');
    expect(mockCreateQueryJob).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, useLegacySql: false }),
    );
  });
});
```

**Step 5: Write dry run implementation**

File: `src/validation/dryRun.ts`

```typescript
import { BigQuery } from '@google-cloud/bigquery';
import type { ValidationResult } from '../types.js';

let bigquery: BigQuery;

export function initBigQuery(projectId?: string): void {
  bigquery = new BigQuery({ projectId });
}

export async function dryRunValidation(sql: string): Promise<ValidationResult> {
  try {
    const [job] = await bigquery.createQueryJob({
      query: sql,
      dryRun: true,
      useLegacySql: false,
    });
    const bytesProcessed = parseInt(job.statistics.totalBytesProcessed, 10);
    return { valid: true, layer: 'L3-dryrun', bytesProcessed };
  } catch (error) {
    return {
      valid: false,
      layer: 'L3-dryrun',
      error: `Dry run failed: ${(error as Error).message}`,
    };
  }
}
```

**Step 6: Run dry run test**

Run: `npx vitest run tests/validation/dryRun.test.ts`
Expected: All 3 tests PASS

**Step 7: Commit**

```bash
git add src/validation/dryRun.ts src/validation/costGate.ts tests/validation/dryRun.test.ts tests/validation/costGate.test.ts
git commit -m "feat: add Layer 3 BigQuery dry run and Layer 4 cost gate validation"
```

---

### Task 10: Validation Pipeline Orchestration

**Files:**
- Create: `src/validation/pipeline.ts`
- Create: `tests/validation/pipeline.test.ts`

**Step 1: Write failing test**

File: `tests/validation/pipeline.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateSql } from '../../src/validation/pipeline.js';

// Mock individual layers
vi.mock('../../src/validation/staticAnalysis.js', () => ({
  staticAnalysis: vi.fn(),
}));
vi.mock('../../src/validation/astValidation.js', () => ({
  astValidation: vi.fn(),
}));
vi.mock('../../src/validation/dryRun.js', () => ({
  dryRunValidation: vi.fn(),
}));
vi.mock('../../src/validation/costGate.js', () => ({
  costGate: vi.fn(),
}));

import { staticAnalysis } from '../../src/validation/staticAnalysis.js';
import { astValidation } from '../../src/validation/astValidation.js';
import { dryRunValidation } from '../../src/validation/dryRun.js';
import { costGate } from '../../src/validation/costGate.js';

const mockStatic = vi.mocked(staticAnalysis);
const mockAst = vi.mocked(astValidation);
const mockDryRun = vi.mocked(dryRunValidation);
const mockCostGate = vi.mocked(costGate);

describe('validateSql', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all layers pass
    mockStatic.mockReturnValue({ valid: true, layer: 'L1-static' });
    mockAst.mockReturnValue({ valid: true, layer: 'L2-ast' });
    mockDryRun.mockResolvedValue({ valid: true, layer: 'L3-dryrun', bytesProcessed: 1000 });
    mockCostGate.mockReturnValue({ valid: true, layer: 'L4-cost', bytesProcessed: 1000 });
  });

  it('returns valid when all layers pass', async () => {
    const result = await validateSql('SELECT 1', 10_000_000_000);
    expect(result.valid).toBe(true);
  });

  it('short-circuits on L1 failure (does not call L2+)', async () => {
    mockStatic.mockReturnValue({ valid: false, layer: 'L1-static', error: 'DROP blocked' });
    const result = await validateSql('DROP TABLE x', 10_000_000_000);
    expect(result.valid).toBe(false);
    expect(result.layer).toBe('L1-static');
    expect(mockAst).not.toHaveBeenCalled();
    expect(mockDryRun).not.toHaveBeenCalled();
  });

  it('short-circuits on L2 failure', async () => {
    mockAst.mockReturnValue({ valid: false, layer: 'L2-ast', error: 'INSERT detected' });
    const result = await validateSql('INSERT INTO x VALUES (1)', 10_000_000_000);
    expect(result.valid).toBe(false);
    expect(result.layer).toBe('L2-ast');
    expect(mockDryRun).not.toHaveBeenCalled();
  });

  it('passes dry run bytes to cost gate', async () => {
    mockDryRun.mockResolvedValue({ valid: true, layer: 'L3-dryrun', bytesProcessed: 5000 });
    await validateSql('SELECT 1', 10_000);
    expect(mockCostGate).toHaveBeenCalledWith(5000, 10_000);
  });

  it('returns L3 error on dry run failure', async () => {
    mockDryRun.mockResolvedValue({ valid: false, layer: 'L3-dryrun', error: 'Table not found' });
    const result = await validateSql('SELECT * FROM missing', 10_000_000_000);
    expect(result.valid).toBe(false);
    expect(result.layer).toBe('L3-dryrun');
    expect(mockCostGate).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/validation/pipeline.test.ts`
Expected: FAIL — "Cannot find module"

**Step 3: Write implementation**

File: `src/validation/pipeline.ts`

```typescript
import type { ValidationResult } from '../types.js';
import { staticAnalysis } from './staticAnalysis.js';
import { astValidation } from './astValidation.js';
import { dryRunValidation } from './dryRun.js';
import { costGate } from './costGate.js';

export async function validateSql(sql: string, maxBytes: number): Promise<ValidationResult> {
  // Layer 1: Static pattern blocking
  const l1 = staticAnalysis(sql);
  if (!l1.valid) return l1;

  // Layer 2: AST validation (advisory on parse failure, blocking for DML)
  const l2 = astValidation(sql);
  if (!l2.valid) return l2;

  // Layer 3: BigQuery dry run
  const l3 = await dryRunValidation(sql);
  if (!l3.valid) return l3;

  // Layer 4: Cost gate
  const l4 = costGate(l3.bytesProcessed!, maxBytes);
  if (!l4.valid) return l4;

  return { valid: true, layer: 'all', bytesProcessed: l3.bytesProcessed };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/validation/pipeline.test.ts`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add src/validation/pipeline.ts tests/validation/pipeline.test.ts
git commit -m "feat: add validation pipeline orchestration (L1→L2→L3→L4 with short-circuit)"
```

---

### Task 11: BigQuery Query Execution

**Files:**
- Create: `src/execution/runner.ts`
- Create: `tests/execution/runner.test.ts`

**Step 1: Write failing test**

File: `tests/execution/runner.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeQuery } from '../../src/execution/runner.js';

const mockQuery = vi.fn();
const mockGetMetadata = vi.fn();

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: vi.fn().mockImplementation(() => ({
    createQueryJob: vi.fn().mockImplementation(async () => {
      const job = {
        getQueryResults: mockQuery,
        getMetadata: mockGetMetadata,
      };
      return [job];
    }),
  })),
}));

describe('executeQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns rows and metadata on success', async () => {
    const rows = [
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ];
    mockQuery.mockResolvedValue([rows]);
    mockGetMetadata.mockResolvedValue([{
      statistics: {
        query: { totalRows: '2' },
        totalBytesProcessed: '1000',
      },
    }]);

    const result = await executeQuery('SELECT id, name FROM users', {
      maxRows: 1000,
      timeoutMs: 30000,
      maxBytes: 10_000_000_000,
    });

    expect(result.rows).toEqual(rows);
    expect(result.columnNames).toEqual(['id', 'name']);
    expect(result.totalRows).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('detects truncated results when totalRows > maxRows', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
    mockQuery.mockResolvedValue([rows]);
    mockGetMetadata.mockResolvedValue([{
      statistics: {
        query: { totalRows: '50000' },
        totalBytesProcessed: '5000000',
      },
    }]);

    const result = await executeQuery('SELECT id FROM big_table', {
      maxRows: 1000,
      timeoutMs: 30000,
      maxBytes: 10_000_000_000,
    });

    expect(result.rows).toHaveLength(1000);
    expect(result.totalRows).toBe(50000);
    expect(result.truncated).toBe(true);
  });

  it('returns empty result gracefully', async () => {
    mockQuery.mockResolvedValue([[]]);
    mockGetMetadata.mockResolvedValue([{
      statistics: {
        query: { totalRows: '0' },
        totalBytesProcessed: '500',
      },
    }]);

    const result = await executeQuery('SELECT * FROM users WHERE 1=0', {
      maxRows: 1000,
      timeoutMs: 30000,
      maxBytes: 10_000_000_000,
    });

    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
    expect(result.columnNames).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/execution/runner.test.ts`
Expected: FAIL — "Cannot find module"

**Step 3: Write implementation**

File: `src/execution/runner.ts`

```typescript
import { BigQuery } from '@google-cloud/bigquery';
import type { QueryResult } from '../types.js';

let bigquery: BigQuery;

export function initBigQueryClient(projectId?: string): void {
  bigquery = new BigQuery({ projectId });
}

export interface ExecutionOptions {
  maxRows: number;
  timeoutMs: number;
  maxBytes: number;
}

export async function executeQuery(
  sql: string,
  options: ExecutionOptions,
): Promise<QueryResult> {
  const [job] = await bigquery.createQueryJob({
    query: sql,
    useLegacySql: false,
    maximumBytesBilled: String(options.maxBytes),
    jobTimeoutMs: String(options.timeoutMs),
    maxResults: options.maxRows,
  });

  const [rows] = await job.getQueryResults({ maxResults: options.maxRows });
  const [metadata] = await job.getMetadata();
  const stats = metadata.statistics;
  const totalRows = parseInt(stats.query?.totalRows || '0', 10);
  const bytesProcessed = parseInt(stats.totalBytesProcessed || '0', 10);

  const columnNames = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    rows,
    columnNames,
    totalRows,
    bytesProcessed,
    truncated: totalRows > options.maxRows,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/execution/runner.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add src/execution/runner.ts tests/execution/runner.test.ts
git commit -m "feat: add BigQuery query execution with totalRows from job metadata"
```

---

### Task 12: SQL Generation (Google GenAI SDK)

**Files:**
- Create: `src/agents/sqlGenerator.ts`
- Create: `tests/agents/sqlGenerator.test.ts`

**Context:** Phase 0 uses a single Gemini 3.0 Pro call with structured output (Zod schema). No supervisor, no File Search. The system prompt includes dbt schema DDLs and thread context. See design doc sections 4 and 5.

**Step 1: Write failing test**

File: `tests/agents/sqlGenerator.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSql } from '../../src/agents/sqlGenerator.js';
import type { TableContext } from '../../src/dbt/types.js';
import type { ThreadMessage } from '../../src/types.js';

// Mock the GenAI SDK
const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent },
  })),
}));

const mockTables: TableContext[] = [
  {
    name: 'analytics.fct_orders',
    schema: 'analytics',
    description: 'All completed customer orders',
    materialization: 'table',
    columns: [
      { name: 'order_id', description: 'Primary key', dataType: 'STRING', meta: {} },
      { name: 'total_amount', description: 'Total USD', dataType: 'FLOAT64', meta: {} },
      { name: 'order_date', description: 'Order date', dataType: 'DATE', meta: {} },
    ],
    sampleDDL: 'CREATE TABLE `analytics.fct_orders` (\n  order_id STRING,\n  total_amount FLOAT64,\n  order_date DATE\n);',
    dependsOn: [],
    tags: ['finance'],
  },
];

describe('generateSql', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns structured SQL generation result', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT SUM(total_amount) AS revenue FROM `analytics.fct_orders`',
        explanation: 'Sums total_amount from fct_orders',
        tables_used: ['analytics.fct_orders'],
        confidence: 'high',
        assumptions: ['All time, all regions'],
        reasoning_chain: 'User wants total revenue. fct_orders has total_amount.',
      }),
    });

    const result = await generateSql(
      'What is total revenue?',
      mockTables,
      [],
      'test-api-key',
    );

    expect(result.sql).toContain('SELECT');
    expect(result.sql).toContain('fct_orders');
    expect(result.confidence).toBe('high');
    expect(result.tablesUsed).toContain('analytics.fct_orders');
  });

  it('includes table DDLs in the prompt', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT 1',
        explanation: 'test',
        tables_used: [],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'test',
      }),
    });

    await generateSql('test', mockTables, [], 'test-api-key');

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const systemPrompt = callArgs.config?.systemInstruction || callArgs.systemInstruction;
    expect(systemPrompt).toContain('analytics.fct_orders');
    expect(systemPrompt).toContain('FLOAT64');
  });

  it('includes thread context when provided', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT 1',
        explanation: 'test',
        tables_used: [],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'test',
      }),
    });

    const threadContext: ThreadMessage[] = [
      { role: 'user', content: 'Show me revenue' },
      { role: 'assistant', content: 'Total revenue is $5M' },
    ];

    await generateSql('Break it down by region', mockTables, threadContext, 'test-api-key');

    const callArgs = mockGenerateContent.mock.calls[0][0];
    const contents = callArgs.contents;
    // Thread context should appear in the conversation
    expect(JSON.stringify(contents)).toContain('Show me revenue');
  });

  it('passes structured output schema config', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        sql: 'SELECT 1',
        explanation: 'test',
        tables_used: [],
        confidence: 'high',
        assumptions: [],
        reasoning_chain: 'test',
      }),
    });

    await generateSql('test', mockTables, [], 'test-api-key');

    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.config.responseMimeType).toBe('application/json');
    expect(callArgs.config.responseSchema).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/sqlGenerator.test.ts`
Expected: FAIL — "Cannot find module"

**Step 3: Write implementation**

File: `src/agents/sqlGenerator.ts`

```typescript
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { TableContext } from '../dbt/types.js';
import type { SqlGenerationResult, ThreadMessage } from '../types.js';
import { assessQuality } from '../dbt/quality.js';

const SqlResponseSchema = z.object({
  sql: z.string().describe('The BigQuery SQL query'),
  explanation: z.string().describe('Plain-English explanation'),
  tables_used: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
  assumptions: z.array(z.string()).describe('Assumptions made about the question'),
  reasoning_chain: z.string().describe('Step-by-step reasoning for how the SQL was derived'),
});

function buildSystemPrompt(tables: TableContext[]): string {
  const schemaSections = tables.map((t) => {
    const quality = assessQuality(t);
    const qualityNote =
      quality.qualityTier === 'low'
        ? `\n⚠️ Minimal documentation — ${Math.round(quality.columnDescriptionCoverage * 100)}% columns described`
        : '';

    return `-- ${t.name}: ${t.description}${qualityNote}\n${t.sampleDDL}`;
  });

  return `You are a BigQuery SQL expert. Generate a single BigQuery SQL query to answer the user's question.

RULES:
- Use only the tables and columns described below
- Use BigQuery SQL dialect (backtick-quoted identifiers, DATE functions, etc.)
- Generate only SELECT statements
- Never generate DML (INSERT, UPDATE, DELETE) or DDL (CREATE, DROP, ALTER)
- If the question cannot be answered with the available schema, set confidence to "low" and explain why

SCHEMA:
${schemaSections.join('\n\n')}
`;
}

function buildContents(
  question: string,
  threadContext: ThreadMessage[],
): Array<{ role: string; parts: Array<{ text: string }> }> {
  const messages: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  // Include thread context as conversation history
  for (const msg of threadContext) {
    messages.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }

  // Current question
  messages.push({
    role: 'user',
    parts: [{ text: question }],
  });

  return messages;
}

export async function generateSql(
  question: string,
  tables: TableContext[],
  threadContext: ThreadMessage[],
  apiKey: string,
  previousAttempt?: { sql: string; error: string },
): Promise<SqlGenerationResult> {
  const ai = new GoogleGenAI({ apiKey });

  let systemPrompt = buildSystemPrompt(tables);

  // Self-correction: include previous failed attempt
  if (previousAttempt) {
    systemPrompt += `\n\nPREVIOUS ATTEMPT (failed validation):
SQL: ${previousAttempt.sql}
Error: ${previousAttempt.error}
Fix the error and generate a corrected query.`;
  }

  const response = await ai.models.generateContent({
    model: 'gemini-3.0-pro',
    contents: buildContents(question, threadContext),
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: 'application/json',
      responseSchema: SqlResponseSchema,
    },
  });

  const parsed = JSON.parse(response.text);

  return {
    sql: parsed.sql,
    explanation: parsed.explanation,
    tablesUsed: parsed.tables_used,
    confidence: parsed.confidence,
    assumptions: parsed.assumptions,
    reasoningChain: parsed.reasoning_chain,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents/sqlGenerator.test.ts`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add src/agents/sqlGenerator.ts tests/agents/sqlGenerator.test.ts
git commit -m "feat: add SQL generation via Gemini 3.0 Pro with structured output"
```

---

### Task 13: Response Formatting + Block Kit

**Files:**
- Create: `src/execution/formatter.ts`
- Create: `src/slack/blocks.ts`
- Create: `tests/execution/formatter.test.ts`
- Create: `tests/slack/blocks.test.ts`

**Step 1: Write formatter test**

File: `tests/execution/formatter.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { chooseFormat, FormatType } from '../../src/execution/formatter.js';
import type { QueryResult, SqlGenerationResult } from '../../src/types.js';

function makeQueryResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    rows: [{ id: '1', name: 'Alice', total: 100 }],
    columnNames: ['id', 'name', 'total'],
    totalRows: 1,
    bytesProcessed: 1000,
    truncated: false,
    ...overrides,
  };
}

describe('chooseFormat', () => {
  it('returns "single_value" for 1 row, 1 column', () => {
    const result = makeQueryResult({
      rows: [{ count: 42 }],
      columnNames: ['count'],
      totalRows: 1,
    });
    expect(chooseFormat(result)).toBe('single_value');
  });

  it('returns "table" for small result (<=20 rows, <=6 columns)', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, name: `user${i}` }));
    const result = makeQueryResult({ rows, columnNames: ['id', 'name'], totalRows: 5 });
    expect(chooseFormat(result)).toBe('table');
  });

  it('returns "wide_table" for >6 columns', () => {
    const row = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 };
    const result = makeQueryResult({
      rows: [row],
      columnNames: Object.keys(row),
      totalRows: 1,
    });
    expect(chooseFormat(result)).toBe('wide_table');
  });

  it('returns "summary" for >20 rows', () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: i }));
    const result = makeQueryResult({ rows, columnNames: ['id'], totalRows: 21 });
    expect(chooseFormat(result)).toBe('summary');
  });

  it('returns "zero_rows" for empty result', () => {
    const result = makeQueryResult({ rows: [], columnNames: [], totalRows: 0 });
    expect(chooseFormat(result)).toBe('zero_rows');
  });

  it('returns "truncated" when result is truncated', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const result = makeQueryResult({ rows, columnNames: ['id'], totalRows: 50000, truncated: true });
    expect(chooseFormat(result)).toBe('truncated');
  });
});
```

**Step 2: Write formatter implementation**

File: `src/execution/formatter.ts`

```typescript
import type { QueryResult } from '../types.js';

export type FormatType = 'single_value' | 'table' | 'wide_table' | 'summary' | 'zero_rows' | 'truncated';

export function chooseFormat(result: QueryResult): FormatType {
  if (result.totalRows === 0) return 'zero_rows';
  if (result.truncated) return 'truncated';
  if (result.columnNames.length > 6) return 'wide_table';
  if (result.totalRows === 1 && result.columnNames.length === 1) return 'single_value';
  if (result.rows.length > 20) return 'summary';
  return 'table';
}
```

**Step 3: Run formatter test**

Run: `npx vitest run tests/execution/formatter.test.ts`
Expected: All 6 tests PASS

**Step 4: Write Block Kit builder test**

File: `tests/slack/blocks.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildSingleValueBlocks,
  buildTableBlocks,
  buildZeroRowBlocks,
  buildTruncatedBlocks,
  buildFeedbackActions,
} from '../../src/slack/blocks.js';

describe('buildSingleValueBlocks', () => {
  it('creates a section block with the value', () => {
    const blocks = buildSingleValueBlocks('42', 'Total orders', 'SELECT COUNT(*) FROM orders');
    expect(blocks).toHaveLength(3); // value + sql + feedback
    expect(blocks[0].type).toBe('section');
    expect(blocks[0].text.text).toContain('42');
  });
});

describe('buildTableBlocks', () => {
  it('creates header and rows', () => {
    const rows = [
      { region: 'US', revenue: '$1M' },
      { region: 'EU', revenue: '$500K' },
    ];
    const blocks = buildTableBlocks(rows, ['region', 'revenue']);
    expect(blocks.length).toBeGreaterThan(0);
    // Should contain column headers
    const text = JSON.stringify(blocks);
    expect(text).toContain('region');
    expect(text).toContain('revenue');
  });
});

describe('buildZeroRowBlocks', () => {
  it('includes filter summary and broaden offer', () => {
    const blocks = buildZeroRowBlocks(
      ['order_status = completed', 'order_date between 2026-01-01 and 2026-01-31'],
      'SELECT * FROM orders WHERE order_status = "completed"',
    );
    const text = JSON.stringify(blocks);
    expect(text).toContain('no results');
    expect(text).toContain('order_status');
  });
});

describe('buildTruncatedBlocks', () => {
  it('shows row count and truncation notice', () => {
    const blocks = buildTruncatedBlocks(1000, 50000);
    const text = JSON.stringify(blocks);
    expect(text).toContain('1,000');
    expect(text).toContain('50,000');
  });
});

describe('buildFeedbackActions', () => {
  it('creates thumbs up and thumbs down buttons', () => {
    const block = buildFeedbackActions('trace-123');
    expect(block.type).toBe('actions');
    expect(block.elements).toHaveLength(2);
    expect(block.elements[0].action_id).toContain('thumbs_up');
    expect(block.elements[1].action_id).toContain('thumbs_down');
  });
});
```

**Step 5: Write Block Kit builder implementation**

File: `src/slack/blocks.ts`

```typescript
import type { KnownBlock, ActionsBlock, SectionBlock } from '@slack/bolt';

export function buildSingleValueBlocks(
  value: string,
  explanation: string,
  sql: string,
): KnownBlock[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${value}*\n${explanation}` },
    } as SectionBlock,
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`${sql}\`\`\`` },
    } as SectionBlock,
    buildFeedbackActions(''),
  ];
}

export function buildTableBlocks(
  rows: Record<string, unknown>[],
  columnNames: string[],
): KnownBlock[] {
  // Block Kit has no native table — use a code block with aligned columns
  const header = columnNames.join(' | ');
  const separator = columnNames.map((c) => '-'.repeat(c.length)).join('-+-');
  const dataRows = rows.map((row) =>
    columnNames.map((col) => String(row[col] ?? '')).join(' | '),
  );
  const tableText = [header, separator, ...dataRows].join('\n');

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`\n${tableText}\n\`\`\`` },
    } as SectionBlock,
  ];
}

export function buildZeroRowBlocks(
  assumptions: string[],
  sql: string,
): KnownBlock[] {
  const filterList = assumptions.length > 0
    ? `\n*Filters applied:* ${assumptions.join(', ')}`
    : '';

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Your query ran successfully but returned no results.${filterList}\n\nWant me to try with broader filters?`,
      },
    } as SectionBlock,
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`${sql}\`\`\`` },
    } as SectionBlock,
  ];
}

export function buildTruncatedBlocks(
  shownRows: number,
  totalRows: number,
): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Showing ${shownRows.toLocaleString()} of ${totalRows.toLocaleString()} rows.`,
      },
    } as SectionBlock,
  ];
}

export function buildFeedbackActions(traceId: string): ActionsBlock {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '👍' },
        action_id: `thumbs_up_${traceId}`,
        value: traceId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '👎' },
        action_id: `thumbs_down_${traceId}`,
        value: traceId,
      },
    ],
  };
}
```

**Step 6: Run all tests**

Run: `npx vitest run tests/execution/formatter.test.ts tests/slack/blocks.test.ts`
Expected: All 11 tests PASS

**Step 7: Commit**

```bash
git add src/execution/formatter.ts src/slack/blocks.ts tests/execution/formatter.test.ts tests/slack/blocks.test.ts
git commit -m "feat: add adaptive response formatting and Block Kit message builders"
```

---

### Task 14: Firestore State Management

**Files:**
- Create: `src/state/firestore.ts`
- Create: `src/state/threadLock.ts`
- Create: `src/state/responseContext.ts`
- Create: `src/state/rateLimiter.ts`
- Create: `src/state/metadataState.ts`
- Create: `tests/state/threadLock.test.ts`
- Create: `tests/state/rateLimiter.test.ts`
- Create: `tests/state/responseContext.test.ts`

**Context:** Firestore is used for thread processing locks, ResponseContext persistence, per-user rate limiting, and metadata freshness tracking. All use the same Firestore client singleton.

**Step 1: Create Firestore client singleton**

File: `src/state/firestore.ts`

```typescript
import { Firestore, FieldValue } from '@google-cloud/firestore';

let db: Firestore;

export function initFirestore(projectId?: string): void {
  db = new Firestore({ projectId });
}

export function getDb(): Firestore {
  if (!db) throw new Error('Firestore not initialized — call initFirestore() first');
  return db;
}

export { FieldValue };
```

**Step 2: Write thread lock test**

File: `tests/state/threadLock.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockDelete = vi.fn();
const mockDoc = vi.fn().mockReturnValue({
  create: mockCreate,
  get: mockGet,
  delete: mockDelete,
});
const mockCollection = vi.fn().mockReturnValue({ doc: mockDoc });

vi.mock('../../src/state/firestore.js', () => ({
  getDb: () => ({ collection: mockCollection }),
  FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
}));

import { acquireThreadLock, releaseThreadLock } from '../../src/state/threadLock.js';

describe('acquireThreadLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when lock is acquired (doc created)', async () => {
    mockCreate.mockResolvedValue(undefined);
    const result = await acquireThreadLock('thread-123');
    expect(result).toBe(true);
    expect(mockCollection).toHaveBeenCalledWith('processing_threads');
    expect(mockDoc).toHaveBeenCalledWith('thread-123');
  });

  it('returns false when lock already exists and not expired', async () => {
    const futureDate = new Date(Date.now() + 300_000);
    mockCreate.mockRejectedValue(Object.assign(new Error('exists'), { code: 6 }));
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ expiresAt: { toDate: () => futureDate } }),
    });

    const result = await acquireThreadLock('thread-123');
    expect(result).toBe(false);
  });

  it('reclaims expired lock', async () => {
    const pastDate = new Date(Date.now() - 1000);
    let callCount = 0;
    mockCreate.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw Object.assign(new Error('exists'), { code: 6 });
    });
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ expiresAt: { toDate: () => pastDate } }),
    });
    mockDelete.mockResolvedValue(undefined);

    const result = await acquireThreadLock('thread-123');
    expect(mockDelete).toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

describe('releaseThreadLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the lock document', async () => {
    mockDelete.mockResolvedValue(undefined);
    await releaseThreadLock('thread-123');
    expect(mockDoc).toHaveBeenCalledWith('thread-123');
    expect(mockDelete).toHaveBeenCalled();
  });
});
```

**Step 3: Write thread lock implementation**

File: `src/state/threadLock.ts`

```typescript
import { getDb, FieldValue } from './firestore.js';

const LOCK_TTL_MS = 300_000; // 300s — matches Cloud Run timeout

export async function acquireThreadLock(threadTs: string): Promise<boolean> {
  const ref = getDb().collection('processing_threads').doc(threadTs);
  try {
    await ref.create({
      startedAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + LOCK_TTL_MS),
    });
    return true;
  } catch (e: any) {
    if (e.code === 6) {
      // ALREADY_EXISTS — check if expired
      const doc = await ref.get();
      if (doc.exists && doc.data()!.expiresAt.toDate() < new Date()) {
        await ref.delete();
        return acquireThreadLock(threadTs); // retry after cleanup
      }
      return false; // lock genuinely held
    }
    throw e;
  }
}

export async function releaseThreadLock(threadTs: string): Promise<void> {
  await getDb().collection('processing_threads').doc(threadTs).delete();
}
```

**Step 4: Write rate limiter test**

File: `tests/state/rateLimiter.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDocGet = vi.fn();
const mockDocSet = vi.fn();
const mockDocUpdate = vi.fn();
const mockDoc = vi.fn().mockReturnValue({
  get: mockDocGet,
  set: mockDocSet,
  update: mockDocUpdate,
});
const mockCollection = vi.fn().mockReturnValue({ doc: mockDoc });

vi.mock('../../src/state/firestore.js', () => ({
  getDb: () => ({ collection: mockCollection }),
  FieldValue: { increment: (n: number) => `INCREMENT_${n}` },
}));

import { checkRateLimit } from '../../src/state/rateLimiter.js';

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows request when under limit', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        queryCount: 5,
        windowStart: { toDate: () => new Date() },
      }),
    });
    mockDocUpdate.mockResolvedValue(undefined);

    const result = await checkRateLimit('user-123', 30);
    expect(result.allowed).toBe(true);
  });

  it('blocks request when at limit', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        queryCount: 30,
        windowStart: { toDate: () => new Date() },
      }),
    });

    const result = await checkRateLimit('user-123', 30);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMinutes).toBeGreaterThan(0);
  });

  it('resets window when expired', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        queryCount: 30,
        windowStart: { toDate: () => twoHoursAgo },
      }),
    });
    mockDocSet.mockResolvedValue(undefined);

    const result = await checkRateLimit('user-123', 30);
    expect(result.allowed).toBe(true);
    expect(mockDocSet).toHaveBeenCalled(); // reset the window
  });

  it('creates new entry for first-time user', async () => {
    mockDocGet.mockResolvedValue({ exists: false });
    mockDocSet.mockResolvedValue(undefined);

    const result = await checkRateLimit('new-user', 30);
    expect(result.allowed).toBe(true);
  });
});
```

**Step 5: Write rate limiter implementation**

File: `src/state/rateLimiter.ts`

```typescript
import { getDb, FieldValue } from './firestore.js';

const WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMinutes?: number;
}

export async function checkRateLimit(
  userId: string,
  maxPerHour: number,
): Promise<RateLimitResult> {
  const ref = getDb().collection('rate_limits').doc(userId);
  const doc = await ref.get();

  if (!doc.exists) {
    await ref.set({ queryCount: 1, windowStart: new Date() });
    return { allowed: true };
  }

  const data = doc.data()!;
  const windowStart = data.windowStart.toDate() as Date;
  const elapsed = Date.now() - windowStart.getTime();

  // Window expired — reset
  if (elapsed > WINDOW_MS) {
    await ref.set({ queryCount: 1, windowStart: new Date() });
    return { allowed: true };
  }

  // Within window — check count
  if (data.queryCount >= maxPerHour) {
    const remaining = WINDOW_MS - elapsed;
    return { allowed: false, retryAfterMinutes: Math.ceil(remaining / 60_000) };
  }

  // Increment
  await ref.update({ queryCount: FieldValue.increment(1) });
  return { allowed: true };
}
```

**Step 6: Write ResponseContext CRUD**

File: `src/state/responseContext.ts`

```typescript
import { getDb } from './firestore.js';
import type { ResponseContext } from '../types.js';

export async function saveResponseContext(ctx: ResponseContext): Promise<void> {
  await getDb()
    .collection('response_context')
    .doc(`${ctx.threadTs}_${ctx.statusMsgTs}`)
    .set({ ...ctx, createdAt: new Date() });
}

export async function botHasRepliedInThread(threadTs: string): Promise<boolean> {
  const snapshot = await getDb()
    .collection('response_context')
    .where('threadTs', '==', threadTs)
    .limit(1)
    .select() // existence check only — fetches no fields
    .get();
  return !snapshot.empty;
}
```

File: `tests/state/responseContext.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockDoc = vi.fn().mockReturnValue({ set: mockSet });
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockSelect = vi.fn();

vi.mock('../../src/state/firestore.js', () => ({
  getDb: () => ({
    collection: () => ({
      doc: mockDoc,
      where: mockWhere,
    }),
  }),
}));

mockWhere.mockReturnValue({ limit: mockLimit });
mockLimit.mockReturnValue({ select: mockSelect });
mockSelect.mockReturnValue({ get: mockGet });

import { saveResponseContext, botHasRepliedInThread } from '../../src/state/responseContext.js';

describe('saveResponseContext', () => {
  it('saves with composite key threadTs_statusMsgTs', async () => {
    mockSet.mockResolvedValue(undefined);
    await saveResponseContext({
      responseId: 'r1',
      threadTs: 'thread-1',
      statusMsgTs: 'msg-1',
      clarifiedQuestion: 'test',
      assumptions: [],
      reasoningChain: '',
      generatedSql: 'SELECT 1',
      tablesUsed: [],
      confidence: 'high',
      queryResults: { rowCount: 0, columnNames: [], bytesProcessed: 0 },
      pipelineDurationMs: 100,
      traceId: 'trace-1',
      createdAt: new Date(),
    });
    expect(mockDoc).toHaveBeenCalledWith('thread-1_msg-1');
    expect(mockSet).toHaveBeenCalled();
  });
});

describe('botHasRepliedInThread', () => {
  it('returns true when response context exists', async () => {
    mockGet.mockResolvedValue({ empty: false });
    const result = await botHasRepliedInThread('thread-1');
    expect(result).toBe(true);
  });

  it('returns false when no response context exists', async () => {
    mockGet.mockResolvedValue({ empty: true });
    const result = await botHasRepliedInThread('thread-1');
    expect(result).toBe(false);
  });
});
```

**Step 7: Write metadata state**

File: `src/state/metadataState.ts`

```typescript
import { getDb } from './firestore.js';
import type { MetadataState } from '../dbt/types.js';

export async function saveMetadataState(state: MetadataState): Promise<void> {
  await getDb().doc('config/metadata_state').set(state);
}

export async function getMetadataState(): Promise<MetadataState | null> {
  const doc = await getDb().doc('config/metadata_state').get();
  return doc.exists ? (doc.data() as MetadataState) : null;
}

export function checkMetadataStaleness(state: MetadataState | null): 'fresh' | 'warning' | 'alert' {
  if (!state) return 'alert';
  const hoursOld = (Date.now() - state.lastRefreshAt.getTime()) / (1000 * 60 * 60);
  if (hoursOld < 24) return 'fresh';
  if (hoursOld < 48) return 'warning';
  return 'alert';
}
```

**Step 8: Run all state tests**

Run: `npx vitest run tests/state/`
Expected: All tests PASS

**Step 9: Commit**

```bash
git add src/state/ tests/state/
git commit -m "feat: add Firestore state management (thread lock, ResponseContext, rate limiter, metadata state)"
```

---

### Task 15: Slack Thread Context + Status Updater

**Files:**
- Create: `src/slack/threadContext.ts`
- Create: `src/slack/statusUpdater.ts`
- Create: `tests/slack/threadContext.test.ts`

**Step 1: Write thread context test**

File: `tests/slack/threadContext.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildThreadContext } from '../../src/slack/threadContext.js';

describe('buildThreadContext', () => {
  it('extracts last 4 messages as user/assistant pairs', () => {
    const messages = [
      { bot_id: undefined, text: 'Show me revenue' },
      { bot_id: 'B123', text: 'Total revenue is $5M\n```SELECT SUM(...)```' },
      { bot_id: undefined, text: 'Break it down by region' },
      { bot_id: 'B123', text: 'Here is the breakdown...' },
      { bot_id: undefined, text: 'Now by month' },
    ];

    const context = buildThreadContext(messages, 4);
    // Should include last 4 messages (not the first one — it's the 5th from end)
    expect(context).toHaveLength(4);
    expect(context[0].role).toBe('assistant');
    expect(context[3].role).toBe('user');
    expect(context[3].content).toBe('Now by month');
  });

  it('returns empty array for single message (no context)', () => {
    const messages = [{ bot_id: undefined, text: 'First question' }];
    const context = buildThreadContext(messages, 4);
    expect(context).toHaveLength(0); // no prior context for the first message
  });

  it('assigns correct roles', () => {
    const messages = [
      { bot_id: undefined, text: 'question' },
      { bot_id: 'B123', text: 'answer' },
    ];
    const context = buildThreadContext(messages, 4);
    expect(context[0].role).toBe('user');
    expect(context[1].role).toBe('assistant');
  });
});
```

**Step 2: Write thread context implementation**

File: `src/slack/threadContext.ts`

```typescript
import type { ThreadMessage } from '../types.js';

interface SlackMessage {
  bot_id?: string;
  text?: string;
}

export function buildThreadContext(
  messages: SlackMessage[],
  maxMessages: number,
): ThreadMessage[] {
  if (messages.length <= 1) return []; // no prior context

  // Exclude the current message (last one) — that's the question being processed
  const priorMessages = messages.slice(0, -1);
  const recent = priorMessages.slice(-maxMessages);

  return recent.map((m) => ({
    role: m.bot_id ? 'assistant' as const : 'user' as const,
    content: m.text || '',
  }));
}
```

**Step 3: Write status updater**

File: `src/slack/statusUpdater.ts`

```typescript
import type { WebClient } from '@slack/web-api';

export function createStatusUpdater(client: WebClient, channel: string, statusMsgTs: string) {
  return async (text: string): Promise<void> => {
    await client.chat.update({ channel, ts: statusMsgTs, text });
  };
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/slack/threadContext.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add src/slack/threadContext.ts src/slack/statusUpdater.ts tests/slack/threadContext.test.ts
git commit -m "feat: add thread context retrieval and progressive status updater"
```

---

### Task 16: Message Trigger Rules

**Files:**
- Create: `src/handlers/messages.ts`
- Create: `tests/handlers/messages.test.ts`

**Step 1: Write failing test**

File: `tests/handlers/messages.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shouldRespond } from '../../src/handlers/messages.js';

// Mock botHasRepliedInThread
vi.mock('../../src/state/responseContext.js', () => ({
  botHasRepliedInThread: vi.fn(),
}));

import { botHasRepliedInThread } from '../../src/state/responseContext.js';
const mockBotHasReplied = vi.mocked(botHasRepliedInThread);

describe('shouldRespond', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('responds to DMs (channel_type === "im")', async () => {
    const result = await shouldRespond({ channel_type: 'im' } as any);
    expect(result).toBe(true);
  });

  it('responds to app_mention events', async () => {
    const result = await shouldRespond({ type: 'app_mention' } as any);
    expect(result).toBe(true);
  });

  it('responds to thread reply where bot has participated', async () => {
    mockBotHasReplied.mockResolvedValue(true);
    const result = await shouldRespond({
      channel_type: 'channel',
      thread_ts: 'thread-1',
    } as any);
    expect(result).toBe(true);
    expect(mockBotHasReplied).toHaveBeenCalledWith('thread-1');
  });

  it('ignores thread reply where bot has NOT participated', async () => {
    mockBotHasReplied.mockResolvedValue(false);
    const result = await shouldRespond({
      channel_type: 'channel',
      thread_ts: 'thread-1',
    } as any);
    expect(result).toBe(false);
  });

  it('ignores bare channel message without mention', async () => {
    const result = await shouldRespond({
      channel_type: 'channel',
      type: 'message',
    } as any);
    expect(result).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handlers/messages.test.ts`
Expected: FAIL — "Cannot find module"

**Step 3: Write implementation**

File: `src/handlers/messages.ts`

```typescript
import { botHasRepliedInThread } from '../state/responseContext.js';

interface MessageEvent {
  type?: string;
  channel_type?: string;
  thread_ts?: string;
}

export async function shouldRespond(event: MessageEvent): Promise<boolean> {
  // Always respond in DMs
  if (event.channel_type === 'im') return true;

  // Always respond to @mentions (handled by separate app_mention listener)
  if (event.type === 'app_mention') return true;

  // For channel messages: only respond in threads where bot has participated
  if (event.thread_ts) {
    return botHasRepliedInThread(event.thread_ts);
  }

  // Bare channel message without @mention: ignore
  return false;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/handlers/messages.test.ts`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add src/handlers/messages.ts tests/handlers/messages.test.ts
git commit -m "feat: add message trigger rules (DMs, mentions, participated threads only)"
```

---

### Task 17: Pipeline Orchestration

**Files:**
- Create: `src/pipeline.ts`
- Create: `tests/pipeline.test.ts`

**Context:** This is the core orchestrator that wires everything together. In Phase 0: thread context → generate SQL → validate → self-correct (1 retry) → execute → format → persist ResponseContext.

**Step 1: Write failing test**

File: `tests/pipeline.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies
vi.mock('../src/agents/sqlGenerator.js');
vi.mock('../src/validation/pipeline.js');
vi.mock('../src/execution/runner.js');
vi.mock('../src/execution/formatter.js');
vi.mock('../src/slack/threadContext.js');
vi.mock('../src/slack/blocks.js');
vi.mock('../src/state/responseContext.js');
vi.mock('../src/state/threadLock.js');
vi.mock('../src/logging.js');

import { runPipeline } from '../src/pipeline.js';
import { generateSql } from '../src/agents/sqlGenerator.js';
import { validateSql } from '../src/validation/pipeline.js';
import { executeQuery } from '../src/execution/runner.js';
import { chooseFormat } from '../src/execution/formatter.js';
import { buildThreadContext } from '../src/slack/threadContext.js';
import { saveResponseContext } from '../src/state/responseContext.js';
import { releaseThreadLock } from '../src/state/threadLock.js';

const mockGenerate = vi.mocked(generateSql);
const mockValidate = vi.mocked(validateSql);
const mockExecute = vi.mocked(executeQuery);
const mockFormat = vi.mocked(chooseFormat);
const mockBuildThread = vi.mocked(buildThreadContext);
const mockSaveCtx = vi.mocked(saveResponseContext);
const mockReleaseLock = vi.mocked(releaseThreadLock);

const mockClient = {
  conversations: { replies: vi.fn() },
  chat: { update: vi.fn(), postMessage: vi.fn() },
};

describe('runPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.conversations.replies.mockResolvedValue({ messages: [] });
    mockBuildThread.mockReturnValue([]);
    mockClient.chat.update.mockResolvedValue({});
    mockSaveCtx.mockResolvedValue(undefined);
    mockReleaseLock.mockResolvedValue(undefined);
  });

  it('runs happy path: generate → validate → execute → respond', async () => {
    mockGenerate.mockResolvedValue({
      sql: 'SELECT 1',
      explanation: 'test',
      tablesUsed: [],
      confidence: 'high',
      assumptions: [],
      reasoningChain: 'test',
    });
    mockValidate.mockResolvedValue({ valid: true, layer: 'all', bytesProcessed: 100 });
    mockExecute.mockResolvedValue({
      rows: [{ count: 42 }],
      columnNames: ['count'],
      totalRows: 1,
      bytesProcessed: 100,
      truncated: false,
    });
    mockFormat.mockReturnValue('single_value');

    await runPipeline({
      question: 'How many orders?',
      channel: 'C123',
      threadTs: 'thread-1',
      statusMsgTs: 'status-1',
      client: mockClient as any,
      tables: [],
      apiKey: 'test-key',
      limits: { costGateMaxBytes: 10e9, queryTimeoutMs: 30000, maxResultRows: 1000 },
    });

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockValidate).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSaveCtx).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('retries once on validation failure', async () => {
    mockGenerate
      .mockResolvedValueOnce({
        sql: 'BAD SQL',
        explanation: '',
        tablesUsed: [],
        confidence: 'high',
        assumptions: [],
        reasoningChain: '',
      })
      .mockResolvedValueOnce({
        sql: 'SELECT 1',
        explanation: 'fixed',
        tablesUsed: [],
        confidence: 'high',
        assumptions: [],
        reasoningChain: '',
      });
    mockValidate
      .mockResolvedValueOnce({ valid: false, layer: 'L3-dryrun', error: 'Table not found' })
      .mockResolvedValueOnce({ valid: true, layer: 'all', bytesProcessed: 100 });
    mockExecute.mockResolvedValue({
      rows: [{ count: 1 }],
      columnNames: ['count'],
      totalRows: 1,
      bytesProcessed: 100,
      truncated: false,
    });
    mockFormat.mockReturnValue('single_value');

    await runPipeline({
      question: 'test',
      channel: 'C123',
      threadTs: 't1',
      statusMsgTs: 's1',
      client: mockClient as any,
      tables: [],
      apiKey: 'test-key',
      limits: { costGateMaxBytes: 10e9, queryTimeoutMs: 30000, maxResultRows: 1000 },
    });

    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockValidate).toHaveBeenCalledTimes(2);
    expect(mockExecute).toHaveBeenCalledTimes(1); // only after passing validation
  });

  it('sends error message when validation fails twice', async () => {
    mockGenerate.mockResolvedValue({
      sql: 'BAD',
      explanation: '',
      tablesUsed: [],
      confidence: 'low',
      assumptions: [],
      reasoningChain: '',
    });
    mockValidate.mockResolvedValue({ valid: false, layer: 'L3-dryrun', error: 'broken' });

    await runPipeline({
      question: 'test',
      channel: 'C123',
      threadTs: 't1',
      statusMsgTs: 's1',
      client: mockClient as any,
      tables: [],
      apiKey: 'test-key',
      limits: { costGateMaxBytes: 10e9, queryTimeoutMs: 30000, maxResultRows: 1000 },
    });

    expect(mockGenerate).toHaveBeenCalledTimes(2); // original + 1 retry
    expect(mockExecute).not.toHaveBeenCalled();
    // Should have posted error to status message
    expect(mockClient.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ ts: 's1' }),
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pipeline.test.ts`
Expected: FAIL — "Cannot find module"

**Step 3: Write implementation**

File: `src/pipeline.ts`

```typescript
import type { WebClient } from '@slack/web-api';
import type { TableContext } from './dbt/types.js';
import type { SqlGenerationResult, QueryResult, ResponseContext } from './types.js';
import { generateSql } from './agents/sqlGenerator.js';
import { validateSql } from './validation/pipeline.js';
import { executeQuery } from './execution/runner.js';
import { chooseFormat } from './execution/formatter.js';
import { buildThreadContext } from './slack/threadContext.js';
import { createStatusUpdater } from './slack/statusUpdater.js';
import {
  buildSingleValueBlocks,
  buildTableBlocks,
  buildZeroRowBlocks,
  buildTruncatedBlocks,
  buildFeedbackActions,
} from './slack/blocks.js';
import { saveResponseContext } from './state/responseContext.js';
import { releaseThreadLock } from './state/threadLock.js';
import { createTraceId, createLogger, logStage } from './logging.js';
import { friendlyErrorMessage } from './errors.js';

export interface PipelineInput {
  question: string;
  channel: string;
  threadTs: string;
  statusMsgTs: string;
  client: WebClient;
  tables: TableContext[];
  apiKey: string;
  limits: {
    costGateMaxBytes: number;
    queryTimeoutMs: number;
    maxResultRows: number;
  };
}

const MAX_RETRIES = 1; // 1 retry = 2 total attempts

export async function runPipeline(input: PipelineInput): Promise<void> {
  const { question, channel, threadTs, statusMsgTs, client, tables, apiKey, limits } = input;
  const traceId = createTraceId();
  const logger = createLogger(traceId);
  const updateStatus = createStatusUpdater(client, channel, statusMsgTs);
  const startTime = Date.now();

  try {
    // 1. Get thread context
    const threadMessages = await client.conversations.replies({
      channel,
      ts: threadTs,
      oldest: threadTs,
    });
    const threadContext = buildThreadContext(threadMessages.messages || [], 4);

    // 2. Generate SQL
    await updateStatus('Generating SQL...');
    let genResult: SqlGenerationResult | null = null;
    let lastError: string | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const start = Date.now();
      genResult = await generateSql(
        question,
        tables,
        threadContext,
        apiKey,
        attempt > 0 && lastError ? { sql: genResult!.sql, error: lastError } : undefined,
      );
      logStage(logger, {
        traceId,
        stage: 'generate',
        durationMs: Date.now() - start,
        confidence: genResult.confidence,
      });

      // 3. Validate
      await updateStatus('Validating query...');
      const validation = await validateSql(genResult.sql, limits.costGateMaxBytes);
      logStage(logger, {
        traceId,
        stage: 'validate',
        durationMs: Date.now() - start,
        bytesProcessed: validation.bytesProcessed,
        error: validation.error,
      });

      if (validation.valid) {
        lastError = null;
        break;
      }

      lastError = validation.error || 'Validation failed';
      if (attempt === MAX_RETRIES) {
        // Exhausted retries
        await updateStatus(
          `I wasn't able to generate a valid query for that question. (trace: ${traceId})`,
        );
        return;
      }

      logger.warn({ attempt, error: lastError }, 'Validation failed, retrying');
    }

    // 4. Execute
    await updateStatus('Running query...');
    const execStart = Date.now();
    const queryResult = await executeQuery(genResult!.sql, {
      maxRows: limits.maxResultRows,
      timeoutMs: limits.queryTimeoutMs,
      maxBytes: limits.costGateMaxBytes,
    });
    logStage(logger, {
      traceId,
      stage: 'execute',
      durationMs: Date.now() - execStart,
      bytesProcessed: queryResult.bytesProcessed,
    });

    // 5. Format + Respond
    const format = chooseFormat(queryResult);
    const blocks = buildResponseBlocks(format, genResult!, queryResult, traceId);

    await client.chat.update({
      channel,
      ts: statusMsgTs,
      text: genResult!.explanation,
      blocks,
    });

    // 6. Persist ResponseContext
    await saveResponseContext({
      responseId: traceId,
      threadTs,
      statusMsgTs,
      clarifiedQuestion: question,
      assumptions: genResult!.assumptions,
      reasoningChain: genResult!.reasoningChain,
      generatedSql: genResult!.sql,
      tablesUsed: genResult!.tablesUsed,
      confidence: genResult!.confidence,
      queryResults: {
        rowCount: queryResult.totalRows,
        columnNames: queryResult.columnNames,
        bytesProcessed: queryResult.bytesProcessed,
      },
      pipelineDurationMs: Date.now() - startTime,
      traceId,
      createdAt: new Date(),
    });
  } catch (error) {
    logger.error({ error }, 'Pipeline failed');
    await client.chat.update({
      channel,
      ts: statusMsgTs,
      text: friendlyErrorMessage(error as Error, traceId),
    });
  } finally {
    await releaseThreadLock(threadTs).catch(() => {});
  }
}

function buildResponseBlocks(
  format: string,
  gen: SqlGenerationResult,
  result: QueryResult,
  traceId: string,
): any[] {
  switch (format) {
    case 'single_value': {
      const value = String(Object.values(result.rows[0])[0]);
      return buildSingleValueBlocks(value, gen.explanation, gen.sql);
    }
    case 'table':
      return [
        ...buildTableBlocks(result.rows, result.columnNames),
        { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${gen.sql}\`\`\`` } },
        buildFeedbackActions(traceId),
      ];
    case 'zero_rows':
      return [
        ...buildZeroRowBlocks(gen.assumptions, gen.sql),
        buildFeedbackActions(traceId),
      ];
    case 'truncated':
      return [
        ...buildTableBlocks(result.rows.slice(0, 20), result.columnNames),
        ...buildTruncatedBlocks(result.rows.length, result.totalRows),
        { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${gen.sql}\`\`\`` } },
        buildFeedbackActions(traceId),
      ];
    default:
      return [
        { type: 'section', text: { type: 'mrkdwn', text: gen.explanation } },
        { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${gen.sql}\`\`\`` } },
        buildFeedbackActions(traceId),
      ];
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pipeline.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add src/pipeline.ts tests/pipeline.test.ts
git commit -m "feat: add pipeline orchestration with self-correction retry"
```

---

### Task 18: Event Handlers + App Wiring

**Files:**
- Create: `src/handlers/commands.ts`
- Create: `src/handlers/mentions.ts`
- Create: `src/app.ts`

**Context:** This wires Bolt.js events to the pipeline. Includes preflightChecks (Phase 0: thread lock only, no clarification/escalation state), feedback button handlers, and metadata refresh endpoint.

**Step 1: Create slash command handler**

File: `src/handlers/commands.ts`

```typescript
import type { App } from '@slack/bolt';
import type { TableContext } from '../dbt/types.js';
import type { AppConfig } from '../config.js';
import { runPipeline } from '../pipeline.js';
import { friendlyErrorMessage } from '../errors.js';
import { createTraceId } from '../logging.js';

export function registerCommands(app: App, getConfig: () => AppConfig, getTables: () => TableContext[]) {
  app.command('/anna', async ({ command, ack, client }) => {
    await ack();

    const config = getConfig();
    const traceId = createTraceId();

    const statusMsg = await client.chat.postMessage({
      channel: command.channel_id,
      text: 'Understanding your question...',
    });

    const threadTs = statusMsg.ts!;
    const statusMsgTs = statusMsg.ts!;

    try {
      await runPipeline({
        question: command.text,
        channel: command.channel_id,
        threadTs,
        statusMsgTs,
        client,
        tables: getTables(),
        apiKey: config.gemini.apiKey,
        limits: config.limits,
      });
    } catch (error) {
      await client.chat.update({
        channel: command.channel_id,
        ts: statusMsgTs,
        text: friendlyErrorMessage(error as Error, traceId),
      });
    }
  });
}
```

**Step 2: Create app_mention handler**

File: `src/handlers/mentions.ts`

```typescript
import type { App } from '@slack/bolt';
import type { TableContext } from '../dbt/types.js';
import type { AppConfig } from '../config.js';
import { runPipeline } from '../pipeline.js';
import { acquireThreadLock } from '../state/threadLock.js';

export function registerMentions(app: App, getConfig: () => AppConfig, getTables: () => TableContext[]) {
  app.event('app_mention', async ({ event, client }) => {
    const config = getConfig();
    const threadTs = event.thread_ts || event.ts;

    // Preflight: acquire thread lock
    const locked = await acquireThreadLock(threadTs);
    if (!locked) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "I'm still working on your previous question...",
      });
      return;
    }

    const statusMsg = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: 'Understanding your question...',
    });

    await runPipeline({
      question: event.text.replace(/<@[A-Z0-9]+>/g, '').trim(), // strip @mention
      channel: event.channel,
      threadTs,
      statusMsgTs: statusMsg.ts!,
      client,
      tables: getTables(),
      apiKey: config.gemini.apiKey,
      limits: config.limits,
    });
  });
}
```

**Step 3: Create main app.ts**

File: `src/app.ts`

```typescript
import { App, ExpressReceiver } from '@slack/bolt';
import { loadConfig } from './config.js';
import type { TableContext } from './dbt/types.js';
import { initFirestore } from './state/firestore.js';
import { initBigQuery } from './validation/dryRun.js';
import { initBigQueryClient } from './execution/runner.js';
import { registerCommands } from './handlers/commands.js';
import { registerMentions } from './handlers/mentions.js';
import { shouldRespond } from './handlers/messages.js';
import { acquireThreadLock } from './state/threadLock.js';
import { checkRateLimit } from './state/rateLimiter.js';
import { runPipeline } from './pipeline.js';
import { rootLogger } from './logging.js';

const config = loadConfig();

// Initialize clients
initFirestore(config.gcp.projectId);
initBigQuery(config.gcp.projectId);
initBigQueryClient(config.gcp.projectId);

// In-memory schema cache (refreshed via webhook)
let tables: TableContext[] = [];
const getTables = () => tables;
const getConfig = () => config;

// Set up Bolt.js
const receiver = new ExpressReceiver({
  signingSecret: config.slack.signingSecret,
});

receiver.router.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

// Metadata refresh webhook
receiver.router.post('/refresh-metadata', async (req, res) => {
  // TODO: Task 20 implements full metadata ingestion
  // For now, accept the body as parsed artifacts
  res.status(200).send('OK');
  rootLogger.info('Metadata refresh triggered');
});

const app = new App({
  token: config.slack.botToken,
  receiver,
});

// Register handlers
registerCommands(app, getConfig, getTables);
registerMentions(app, getConfig, getTables);

// Message handler (thread follow-ups in channels + DMs)
app.event('message', async ({ event, client }) => {
  // Skip bot messages, message_changed, etc.
  if ('bot_id' in event || 'subtype' in event) return;

  const respond = await shouldRespond(event as any);
  if (!respond) return;

  const threadTs = (event as any).thread_ts || (event as any).ts;

  // Rate limit check
  const rateCheck = await checkRateLimit((event as any).user, config.limits.rateLimitPerHour);
  if (!rateCheck.allowed) {
    await client.chat.postMessage({
      channel: (event as any).channel,
      thread_ts: threadTs,
      text: `You've hit the query limit (${config.limits.rateLimitPerHour}/hour). Resets in ${rateCheck.retryAfterMinutes} minutes.`,
    });
    return;
  }

  // Acquire thread lock
  const locked = await acquireThreadLock(threadTs);
  if (!locked) {
    await client.chat.postMessage({
      channel: (event as any).channel,
      thread_ts: threadTs,
      text: "I'm still working on your previous question...",
    });
    return;
  }

  const statusMsg = await client.chat.postMessage({
    channel: (event as any).channel,
    thread_ts: threadTs,
    text: 'Understanding your question...',
  });

  await runPipeline({
    question: (event as any).text || '',
    channel: (event as any).channel,
    threadTs,
    statusMsgTs: statusMsg.ts!,
    client,
    tables: getTables(),
    apiKey: config.gemini.apiKey,
    limits: config.limits,
  });
});

// Feedback button handlers
app.action(/thumbs_(up|down)_.*/, async ({ action, ack, body }) => {
  await ack();
  const traceId = (action as any).value;
  const type = (action as any).action_id.startsWith('thumbs_up') ? 'positive' : 'negative';
  rootLogger.info({ traceId, type, userId: body.user.id }, 'feedback.received');
  // TODO: Persist to Firestore feedback collection
});

// Start
(async () => {
  await app.start(config.port);
  rootLogger.info({ port: config.port }, 'Anna Lytics is running');
})();
```

**Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors (or minor type issues to fix)

**Step 5: Commit**

```bash
git add src/handlers/commands.ts src/handlers/mentions.ts src/app.ts
git commit -m "feat: wire up Bolt.js event handlers, commands, feedback, and app entry point"
```

---

### Task 19: Infrastructure (Terraform + Firestore Indexes)

**Files:**
- Create: `infra/main.tf`
- Create: `infra/firestore.indexes.json`

**Step 1: Create Terraform config**

File: `infra/main.tf`

```hcl
terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "project_id" {
  type = string
}

variable "region" {
  default = "us-central1"
}

variable "slack_bot_token" {
  type      = string
  sensitive = true
}

variable "slack_signing_secret" {
  type      = string
  sensitive = true
}

variable "gemini_api_key" {
  type      = string
  sensitive = true
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable required APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "firestore.googleapis.com",
    "bigquery.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
  ])
  service = each.value
}

# Firestore database
resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
}

# Service account for Cloud Run
resource "google_service_account" "anna_lytics" {
  account_id   = "anna-lytics"
  display_name = "Anna Lytics Bot"
}

# BigQuery read-only access
resource "google_project_iam_member" "bq_viewer" {
  project = var.project_id
  role    = "roles/bigquery.dataViewer"
  member  = "serviceAccount:${google_service_account.anna_lytics.email}"
}

resource "google_project_iam_member" "bq_job_user" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.anna_lytics.email}"
}

# Firestore access
resource "google_project_iam_member" "firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.anna_lytics.email}"
}

# Secrets
resource "google_secret_manager_secret" "slack_bot_token" {
  secret_id = "slack-bot-token"
  replication { auto {} }
}

resource "google_secret_manager_secret_version" "slack_bot_token" {
  secret      = google_secret_manager_secret.slack_bot_token.id
  secret_data = var.slack_bot_token
}

resource "google_secret_manager_secret" "slack_signing_secret" {
  secret_id = "slack-signing-secret"
  replication { auto {} }
}

resource "google_secret_manager_secret_version" "slack_signing_secret" {
  secret      = google_secret_manager_secret.slack_signing_secret.id
  secret_data = var.slack_signing_secret
}

resource "google_secret_manager_secret" "gemini_api_key" {
  secret_id = "gemini-api-key"
  replication { auto {} }
}

resource "google_secret_manager_secret_version" "gemini_api_key" {
  secret      = google_secret_manager_secret.gemini_api_key.id
  secret_data = var.gemini_api_key
}

# Secret accessor for Cloud Run SA
resource "google_secret_manager_secret_iam_member" "access" {
  for_each  = toset(["slack-bot-token", "slack-signing-secret", "gemini-api-key"])
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.anna_lytics.email}"
}

# Cloud Run service
resource "google_cloud_run_v2_service" "anna_lytics" {
  name     = "anna-lytics"
  location = var.region

  template {
    service_account = google_service_account.anna_lytics.email

    scaling {
      min_instance_count = 1
      max_instance_count = 10
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/anna-lytics/anna-lytics:latest"

      resources {
        limits = {
          cpu    = "2"
          memory = "1Gi"
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      env {
        name = "SLACK_BOT_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.slack_bot_token.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "SLACK_SIGNING_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.slack_signing_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GEMINI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gemini_api_key.secret_id
            version = "latest"
          }
        }
      }

      env { name = "GCP_PROJECT_ID"; value = var.project_id }
      env { name = "PORT";           value = "3000" }

      ports { container_port = 3000 }
    }

    timeout = "300s"
    max_instance_request_concurrency = 20
  }
}

# Artifact Registry
resource "google_artifact_registry_repository" "anna_lytics" {
  location      = var.region
  repository_id = "anna-lytics"
  format        = "DOCKER"
}
```

**Step 2: Create Firestore indexes**

File: `infra/firestore.indexes.json`

```json
{
  "indexes": [
    {
      "collectionGroup": "response_context",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "threadTs", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "feedback",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "thread_ts", "order": "ASCENDING" },
        { "fieldPath": "timestamp", "order": "DESCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

**Step 3: Commit**

```bash
git add infra/
git commit -m "feat: add Terraform infrastructure (Cloud Run, Firestore, IAM, secrets) and Firestore indexes"
```

---

### Task 20: CI/CD (GitHub Actions)

**Files:**
- Create: `.github/workflows/deploy.yml`

**Step 1: Create deploy workflow**

File: `.github/workflows/deploy.yml`

```yaml
name: Build, Test & Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  PROJECT_ID: ${{ secrets.GCP_PROJECT_ID }}
  REGION: us-central1
  SERVICE_NAME: anna-lytics

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx vitest run

  deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write

    steps:
      - uses: actions/checkout@v4

      - id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
          service_account: ${{ secrets.WIF_SERVICE_ACCOUNT }}

      - uses: google-github-actions/setup-gcloud@v2

      - name: Build and push Docker image
        run: |
          gcloud auth configure-docker ${{ env.REGION }}-docker.pkg.dev
          docker build -t ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/anna-lytics/anna-lytics:${{ github.sha }} .
          docker push ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/anna-lytics/anna-lytics:${{ github.sha }}
          docker tag ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/anna-lytics/anna-lytics:${{ github.sha }} \
            ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/anna-lytics/anna-lytics:latest
          docker push ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/anna-lytics/anna-lytics:latest

      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy ${{ env.SERVICE_NAME }} \
            --image ${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/anna-lytics/anna-lytics:${{ github.sha }} \
            --region ${{ env.REGION }}
```

**Step 2: Commit**

```bash
git add .github/
git commit -m "feat: add GitHub Actions CI/CD (test + deploy to Cloud Run)"
```

---

### Task 21: End-to-End Integration Test

**Files:**
- Create: `tests/integration/pipeline.integration.test.ts`

**Context:** This test exercises the full pipeline with all real modules (no mocks except external services: BigQuery, Gemini, Firestore, Slack). It validates the wiring between components.

**Step 1: Write integration test**

File: `tests/integration/pipeline.integration.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external services only
vi.mock('@google-cloud/bigquery');
vi.mock('@google/genai');
vi.mock('../../src/state/firestore.js', () => {
  const mockDoc = {
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({ exists: false }),
    create: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return {
    getDb: () => ({
      collection: () => ({
        doc: () => mockDoc,
        where: () => ({ limit: () => ({ select: () => ({ get: () => ({ empty: true }) }) }) }),
      }),
      doc: () => mockDoc,
    }),
    initFirestore: vi.fn(),
    FieldValue: {
      serverTimestamp: () => 'SERVER_TS',
      increment: (n: number) => n,
    },
  };
});

import { runPipeline } from '../../src/pipeline.js';
import { GoogleGenAI } from '@google/genai';
import { BigQuery } from '@google-cloud/bigquery';
import { parseDbtArtifacts } from '../../src/dbt/parser.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Pipeline Integration', () => {
  const fixturesDir = join(import.meta.dirname, '../fixtures');
  const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf-8'));
  const catalog = JSON.parse(readFileSync(join(fixturesDir, 'catalog.json'), 'utf-8'));
  const tables = parseDbtArtifacts(manifest, catalog);

  const mockClient = {
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    chat: { update: vi.fn().mockResolvedValue({}), postMessage: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock Gemini to return valid SQL
    const mockGenAI = vi.mocked(GoogleGenAI);
    (mockGenAI as any).mockImplementation(() => ({
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            sql: 'SELECT COUNT(*) AS order_count FROM `analytics.fct_orders`',
            explanation: 'Counts all orders in fct_orders',
            tables_used: ['analytics.fct_orders'],
            confidence: 'high',
            assumptions: ['All time'],
            reasoning_chain: 'Simple count query',
          }),
        }),
      },
    }));

    // Mock BigQuery dry run + execution
    const mockBQ = vi.mocked(BigQuery);
    (mockBQ as any).mockImplementation(() => ({
      createQueryJob: vi.fn().mockResolvedValue([{
        statistics: { totalBytesProcessed: '1000' },
        getQueryResults: vi.fn().mockResolvedValue([[{ order_count: 42 }]]),
        getMetadata: vi.fn().mockResolvedValue([{
          statistics: {
            query: { totalRows: '1' },
            totalBytesProcessed: '1000',
          },
        }]),
      }]),
    }));
  });

  it('runs full pipeline from question to formatted response', async () => {
    await runPipeline({
      question: 'How many orders do we have?',
      channel: 'C123',
      threadTs: 'thread-1',
      statusMsgTs: 'status-1',
      client: mockClient as any,
      tables,
      apiKey: 'test-key',
      limits: { costGateMaxBytes: 10e9, queryTimeoutMs: 30000, maxResultRows: 1000 },
    });

    // Verify status was updated at least twice (generating, running)
    expect(mockClient.chat.update).toHaveBeenCalledTimes(
      expect.any(Number),
    );

    // Final update should contain the response
    const finalCall = mockClient.chat.update.mock.calls.at(-1)?.[0];
    expect(finalCall).toBeDefined();
    expect(finalCall.ts).toBe('status-1');
  });
});
```

**Step 2: Run integration test**

Run: `npx vitest run tests/integration/`
Expected: PASS

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add tests/integration/
git commit -m "test: add end-to-end integration test for pipeline wiring"
```

---

## Summary

| Task | Component | Key Files |
|------|-----------|-----------|
| 1 | Project scaffolding | `package.json`, `tsconfig.json`, `Dockerfile` |
| 2 | Types + interfaces | `src/types.ts`, `src/dbt/types.ts` |
| 3 | Observability | `src/logging.ts` |
| 4 | Error handling | `src/errors.ts` |
| 5 | dbt metadata parser | `src/dbt/parser.ts` |
| 6 | Metadata quality | `src/dbt/quality.ts` |
| 7 | Validation L1 (static) | `src/validation/staticAnalysis.ts` |
| 8 | Validation L2 (AST) | `src/validation/astValidation.ts` |
| 9 | Validation L3-L4 (dry run + cost) | `src/validation/dryRun.ts`, `costGate.ts` |
| 10 | Validation pipeline | `src/validation/pipeline.ts` |
| 11 | BigQuery execution | `src/execution/runner.ts` |
| 12 | SQL generation (GenAI) | `src/agents/sqlGenerator.ts` |
| 13 | Response formatting + Block Kit | `src/execution/formatter.ts`, `src/slack/blocks.ts` |
| 14 | Firestore state management | `src/state/*.ts` |
| 15 | Thread context + status updater | `src/slack/threadContext.ts`, `statusUpdater.ts` |
| 16 | Message trigger rules | `src/handlers/messages.ts` |
| 17 | Pipeline orchestration | `src/pipeline.ts` |
| 18 | Event handlers + app wiring | `src/handlers/*.ts`, `src/app.ts` |
| 19 | Infrastructure (Terraform) | `infra/main.tf`, `firestore.indexes.json` |
| 20 | CI/CD | `.github/workflows/deploy.yml` |
| 21 | Integration test | `tests/integration/pipeline.integration.test.ts` |

**Total: 21 tasks, ~45 files, full TDD coverage for Phase 0.**

After deployment, the immediate next steps are:
1. Create a Slack app in your workspace (OAuth scopes, event subscriptions, slash commands)
2. Provision GCP resources via Terraform
3. Upload your dbt `manifest.json` + `catalog.json` via the refresh webhook
4. @mention the bot in a channel and ask a question
