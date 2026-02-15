# Anna Lytics - Design Document

**Date**: 2026-02-15
**Status**: Approved

---

## 1. Product Overview

Anna Lytics is a Slack bot that enables business users to query a BigQuery data warehouse using natural language. It uses dbt metadata as a rich semantic layer, supports adaptive response formats, and is designed for extensibility toward Dataproc/PySpark and Databricks pipelines.

### MVP Persona

Non-technical business stakeholders (<50 users) who currently ask the data team for ad-hoc queries. Anna Lytics lets them self-serve in Slack.

### Core MVP Features

1. Natural-language questions to BigQuery SQL to results (read-only, auto-execute)
2. dbt metadata (manifest.json + catalog.json) as primary schema context, BigQuery INFORMATION_SCHEMA as fallback
3. dbt model freshness/run status queries ("when was `customers` last built?")
4. Adaptive response format (numbers, tables, summaries depending on question type)
5. Thumbs-up/down feedback for continuous improvement

### Out of Scope (MVP)

- Triggering dbt runs from Slack
- Dataproc/PySpark integration
- Databricks integration
- Multi-tenant SaaS distribution
- Chart/visualization generation

---

## 2. Architecture

### MVP: Single Cloud Run Service + Async Pattern

```
                         +---------------------------------------------+
                         |              Cloud Run Service               |
  Slack Events API ----> |  Bolt.js (HTTP mode, ExpressReceiver)        |
  (HTTP POST)            |    |                                         |
                         |    +-- ack() immediately (<3s)               |
                         |    +-- Post "thinking..." message            |
                         |    +-- async: generate SQL -> validate ->    |
                         |         execute -> update Slack message      |
                         +------+-----------+-----------+---------------+
                                |           |           |
                                v           v           v
                          BigQuery    Vercel AI SDK   Firestore
                       (read-only SA) (Claude/GPT)  (conversation
                                                     history +
                                                     feedback)
```

### Production Evolution: Two-Service Pattern

For production traffic, split into Receiver + Worker via Cloud Tasks:

```
Slack --> Cloud Run "Receiver" (Bolt.js)
              |
              +-- ack() immediately
              +-- enqueue to Cloud Tasks
                        |
                        v
          Cloud Run "Worker" (processes task)
              |
              +-- BigQuery query / LLM call
              +-- post result to Slack via Web API
```

Cloud Tasks provides built-in rate limiting, retries, deduplication, and independent scaling.

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Slack connection mode | HTTP (Events API) | Natural Cloud Run fit, no connection limits, Marketplace compatible |
| `processBeforeResponse` | `false` (default) | Cloud Run keeps process alive after response; allows background work |
| Cold start mitigation | `min-instances=1` + CPU boost + always-on CPU | Eliminates 0-to-1 cold start, speeds up N-to-N+1 |
| Async processing (MVP) | Inline after `ack()` | Simple, sufficient for <50 users |
| Async processing (prod) | Cloud Tasks | Rate limiting, retries, dedup built in |
| Primary state store | Firestore | Serverless, no VPC needed, durable |

### Cloud Run Configuration

```bash
gcloud run deploy anna-lytics \
  --image gcr.io/$PROJECT_ID/anna-lytics \
  --min-instances=1 \
  --max-instances=10 \
  --cpu=1 \
  --memory=512Mi \
  --concurrency=80 \
  --cpu-boost \
  --no-cpu-throttling \
  --timeout=60 \
  --region=us-central1
```

---

## 3. Core Request Flow

```
User: "How many customers signed up last month?"
                    |
                    v
    +--- 1. Bolt.js receives Slack event ---+
    |   - ack() immediately                 |
    |   - Post ephemeral "Thinking..." msg  |
    +----------------+---------------------+
                     v
    +--- 2. Schema Retrieval ---------------+
    |   - Embed user question               |
    |   - Retrieve top 5-15 relevant tables |
    |     from dbt metadata index           |
    |   - If <30 tables total, use all      |
    +----------------+---------------------+
                     v
    +--- 3. SQL Generation (Vercel AI SDK) -+
    |   - System prompt with:               |
    |     - BigQuery SQL rules              |
    |     - Retrieved table DDLs            |
    |     - Column descriptions from dbt    |
    |     - Sample rows                     |
    |     - Dynamic few-shot examples       |
    |   - Structured output via Zod:        |
    |     { sql, explanation, confidence }  |
    +----------------+---------------------+
                     v
    +--- 4. Validation Pipeline ------------+
    |   L1: Static pattern blocking         |
    |   L2: AST parse (node-sql-parser)     |
    |   L3: BigQuery dry run (FREE)         |
    |   L4: Cost gate (max 10GB default)    |
    |   - If any layer fails -> self-correct|
    |     (retry up to 2x with error msg)   |
    +----------------+---------------------+
                     v
    +--- 5. Execute + Respond --------------+
    |   - Run query (30s timeout, 1K rows)  |
    |   - Adaptive formatting:              |
    |     - Single value -> plain text      |
    |     - Small table -> Block Kit table  |
    |     - Large result -> summary + CSV   |
    |   - Include thumbs-up/down buttons    |
    |   - Log to feedback store             |
    +--------------------------------------+
```

---

## 4. LLM Layer

### Abstraction: Vercel AI SDK v5+

The Vercel AI SDK is the TypeScript equivalent of Python's LiteLLM:
- 25+ providers, one-line switching between Claude, GPT, Gemini, etc.
- Structured output via Zod schemas (perfect for SQL + metadata extraction)
- Streaming-first (update Slack messages progressively)
- No framework lock-in (works on Cloud Run, no Next.js required)

### Model Strategy

| Task | Model | Rationale |
|------|-------|-----------|
| SQL generation | Claude Sonnet / GPT-4o | Best accuracy on text-to-SQL benchmarks |
| Question classification | Claude Haiku / GPT-4o-mini | Cheap + fast routing ("data question?" vs "dbt status?") |
| Result summarization | Claude Haiku / GPT-4o-mini | Turn tabular results into natural language |

### Structured Output Pattern

```typescript
import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

const { object } = await generateObject({
  model: anthropic('claude-sonnet-4-5-20250929'),
  schema: z.object({
    sql: z.string().describe('The BigQuery SQL query'),
    explanation: z.string().describe('Plain-English explanation'),
    tables_used: z.array(z.string()),
    confidence: z.enum(['high', 'medium', 'low']),
  }),
  system: systemPromptWithSchemaContext,
  prompt: userQuestion,
});
```

### Accuracy Expectations

State-of-the-art benchmarks (BIRD) show 71-77%. With a curated dbt semantic layer + few-shot examples + domain-specific tuning, expect 75-90% accuracy on common query patterns. The bot should clearly communicate confidence levels and gracefully handle cases where it cannot generate a reliable query.

---

## 5. Prompt Engineering

### Prompt Structure

```
You are a BigQuery SQL expert. Generate a single BigQuery SQL query
to answer the user's question.

RULES:
- Use only the tables and columns described below
- Use BigQuery SQL dialect (backtick-quoted identifiers, DATE functions, etc.)
- Generate only SELECT statements
- Never generate DML (INSERT, UPDATE, DELETE) or DDL (CREATE, DROP, ALTER)
- If the question cannot be answered with the available schema, say so

SCHEMA:
{dynamically_retrieved_table_definitions}

SAMPLE DATA:
{sample_rows_for_relevant_tables}

BUSINESS CONTEXT:
{relevant_metric_definitions_from_dbt}

EXAMPLES:
{few_shot_examples_similar_to_current_question}

USER QUESTION: {question}
```

### Schema Context Priority

1. **Curated CREATE TABLE DDL** (highest impact)
2. **Column comments/descriptions** (high impact)
3. **Sample rows** (high impact, +6 percentage points on Spider benchmark)
4. **Foreign key relationships** (medium impact)
5. **Enumerated values** (medium impact)
6. **Business glossary** (medium impact)

### Schema Retrieval Strategy

- **<30 tables**: Include full schema in every prompt (no RAG needed)
- **>30 tables**: Embed table descriptions into a vector store, retrieve top 5-15 relevant tables per query
- **Sweet spot**: 5-15 relevant tables retrieved dynamically

### Advanced Techniques

- **Dynamic few-shot selection**: Maintain curated (question, SQL) pairs. Retrieve the 3-5 most semantically similar examples per query.
- **Chain-of-thought**: For complex queries, ask the model to plan before generating SQL.
- **Self-correction loops**: On execution failure, feed the error back and retry (up to 2 attempts).

---

## 6. dbt Integration

### Metadata Ingestion

Parse two dbt artifacts:

| Artifact | Source | Provides |
|----------|--------|----------|
| `manifest.json` | Any dbt parse/compile | Model descriptions, column descriptions, lineage, tags, compiled SQL, materialization |
| `catalog.json` | `dbt docs generate` | Column data types, table statistics, row counts |

**Merge strategy**: manifest.json for business context (human-authored descriptions), catalog.json for warehouse-verified types and stats.

### Parsing Pattern

```typescript
interface TableContext {
  name: string;
  schema: string;
  description: string;
  materialization: string;
  columns: {
    name: string;
    description: string;
    dataType: string;
    meta: Record<string, any>;
  }[];
  sampleDDL: string;
  dependsOn: string[];
  tags: string[];
}

function parseDbtArtifacts(manifest: any, catalog: any): TableContext[] {
  const tables: TableContext[] = [];
  for (const [nodeId, node] of Object.entries(manifest.nodes)) {
    if (node.resource_type !== 'model') continue;
    const catalogNode = catalog.nodes[nodeId];
    const columns = Object.values(node.columns).map(col => ({
      name: col.name,
      description: col.description || '',
      dataType: catalogNode?.columns?.[col.name]?.type || 'UNKNOWN',
      meta: col.meta || {},
    }));
    tables.push({
      name: `${node.schema}.${node.name}`,
      schema: node.schema,
      description: node.description || '',
      materialization: node.config?.materialized || 'view',
      columns,
      sampleDDL: generateDDL(node, catalogNode),
      dependsOn: node.depends_on?.nodes || [],
      tags: node.tags || [],
    });
  }
  return tables;
}
```

### Focus on Mart/Gold Layer

Only expose mart/gold layer models to the LLM (not staging or intermediate). These are the business-facing tables that users think about.

### Refresh Strategy

Refresh the metadata index on dbt CI completion via:
- GitHub Actions webhook after `dbt build` completes
- Periodic poll of artifacts from dbt Cloud API or GitHub repo

### Run Status (MVP)

Parse `run_results.json` from the most recent dbt run to answer:
- "When was `dim_customers` last built?"
- "Did the last dbt run succeed?"
- "Which models failed?"

---

## 7. Query Validation Pipeline

### 5-Layer Defense

```
LLM SQL Generation
    |
    v
Layer 1: Static Analysis (pattern blocking)
    |
    v
Layer 2: AST Validation (node-sql-parser, SELECT-only)
    |
    v
Layer 3: BigQuery Dry Run (FREE - validates syntax, tables, columns, permissions)
    |
    v
Layer 4: Cost Gate (max bytes threshold, e.g., 10GB)
    |
    v
Layer 5: Execution with Limits (30s timeout, 1K row limit, maximumBytesBilled)
```

### Layer Details

**Layer 1 - Static Analysis**: Regex-based blocking of `DROP`, `ALTER`, `DELETE`, `INSERT`, `UPDATE`, `CREATE`, `GRANT`, `REVOKE`, SQL comments, multi-statement queries.

**Layer 2 - AST Validation**: Parse with `node-sql-parser` (BigQuery dialect). Walk the AST to verify only `SELECT` statements exist. Check referenced tables against an allowlist.

**Layer 3 - BigQuery Dry Run**: The most important layer. Free (no slot usage, no charges). Provides full syntax validation, semantic validation (table/column existence, data types, permissions), and estimated bytes to process.

```typescript
const [job] = await bigquery.createQueryJob({
  query: sql,
  dryRun: true,
  useLegacySql: false,
});
const bytesProcessed = parseInt(job.statistics.totalBytesProcessed, 10);
```

**Layer 4 - Cost Gate**: Compare dry run's `bytesProcessed` against a configurable threshold. Default: 10GB (~$0.05 at on-demand pricing).

**Layer 5 - Execution**: Run with `maximumBytesBilled` (hard cap), `jobTimeoutMs: 30000`, and `maxResults: 1000`.

### Infrastructure-Level Safety

- **Read-only service account**: `bigquery.dataViewer` + `bigquery.jobUser` only
- **Dataset-level permissions**: Restrict to mart/gold datasets
- **Per-user daily quota**: Set via BigQuery project settings

---

## 8. Slack Integration

### Bolt.js Configuration

```typescript
import { App, ExpressReceiver } from '@slack/bolt';

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

receiver.router.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

(async () => {
  await app.start(Number(process.env.PORT) || 3000);
})();
```

### OAuth Scopes Required

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Detect @AnnaLytics mentions |
| `channels:history` | Read thread context in public channels |
| `groups:history` | Read thread context in private channels |
| `im:history` | Read DM thread context |
| `chat:write` | Send responses |
| `commands` | Slash commands (`/anna`) |
| `users:read` | Display user names |
| `reactions:read` | Detect thumbs-up/down feedback |
| `files:write` | Upload CSV exports |

### Event Subscriptions

| Event | Purpose |
|-------|---------|
| `app_mention` | Respond when @mentioned |
| `message.channels` | Listen for thread replies |
| `message.groups` | Listen for private channel threads |
| `message.im` | Listen for DMs |

### Multi-Turn Threading

```typescript
const thread = await client.conversations.replies({
  channel,
  ts: thread_ts,
  oldest: thread_ts,
});

const conversationHistory = thread.messages!.map((m) => ({
  role: m.bot_id ? 'assistant' : 'user',
  content: m.text || '',
}));
```

### Adaptive Response Format

| Question Type | Response Format |
|--------------|-----------------|
| Single value ("how many...") | Plain text with explanation |
| Small table (<20 rows) | Block Kit section blocks formatted as table |
| Large result (>20 rows) | Natural language summary + CSV file upload |

### Block Kit Constraints

- Max 50 blocks per message
- ~13K character aggregate limit across all blocks (undocumented but enforced)
- Use `slack-block-builder` npm package for pagination and rich formatting

### Handling the 3-Second Timeout

```typescript
app.command('/anna', async ({ command, ack, client }) => {
  await ack('Thinking...');

  // Background work continues (Cloud Run keeps process alive)
  try {
    const results = await processQuery(command.text);
    await client.chat.postMessage({
      channel: command.channel_id,
      text: results.formatted,
      blocks: results.blocks,
    });
  } catch (error) {
    await client.chat.postMessage({
      channel: command.channel_id,
      text: `Something went wrong: ${error.message}`,
    });
  }
});
```

---

## 9. Feedback and Learning

### Feedback Tiers

**Tier 1 - Implicit (automatic)**:
- Execution success/failure
- Error messages
- Result emptiness (zero rows often indicates wrong filters)
- Latency and cost

**Tier 2 - Explicit (low friction)**:
- Thumbs-up/down Slack buttons on every response
- "This is wrong" button opens a thread for user to explain expected result

**Tier 3 - Analyst Review (post-MVP)**:
- Thumbs-down triggers analyst review queue
- Analysts correct SQL; corrected pairs become few-shot examples
- System improves over time as example pool grows

**Tier 4 - Auto-correction**:
- On execution failure, retry with error context (up to 2 attempts)
- On validation failure, feed error back to LLM for self-correction

### Feedback Storage

Firestore collection: `feedback`
```
{
  question: string,
  generated_sql: string,
  correct_sql?: string,
  feedback_type: 'positive' | 'negative' | 'auto',
  execution_success: boolean,
  result_row_count: number,
  latency_ms: number,
  estimated_cost_usd: number,
  user_id: string,
  channel_id: string,
  thread_ts: string,
  timestamp: Date,
}
```

---

## 10. Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Runtime | Cloud Run (Node.js 20, distroless) | Serverless, GCP-native, IAM integration |
| Bot framework | Bolt.js (TypeScript, HTTP mode) | Official Slack SDK, first-class TS support |
| LLM abstraction | Vercel AI SDK v5 | Provider-agnostic, Zod structured output, streaming |
| Database client | @google-cloud/bigquery | Official Node.js client |
| SQL validation | node-sql-parser | AST-level SELECT-only enforcement |
| State/feedback | Firestore | Serverless, no connection pool, thread context |
| Schema index | In-memory (MVP) -> vector DB later | <30 tables: no RAG needed; >30: add vector store |
| dbt metadata | Custom parser (manifest.json + catalog.json) | Direct parsing, no external deps |
| Infra-as-code | Terraform | Cloud Run + IAM + Firestore provisioning |
| CI/CD | GitHub Actions | Build, test, deploy to Cloud Run |

---

## 11. Extensibility Path

| Phase | Addition | Approach |
|-------|----------|----------|
| Post-MVP | Trigger dbt runs from Slack | GitHub Actions API to trigger dbt workflow |
| Post-MVP | Chart/visualization | Server-side chart generation (chart.js + canvas) uploaded as Slack images |
| Future | Dataproc/PySpark | Plugin architecture: add a "pipeline provider" interface alongside dbt |
| Future | Databricks | Same plugin interface, Databricks REST API for job status and SQL warehouse queries |
| Future | Multi-tenant | Tenant isolation via separate BigQuery service accounts + Firestore namespacing |

The LLM abstraction (Vercel AI SDK) and the pipeline metadata interface should be designed as pluggable from day one, even though only BigQuery + dbt are implemented in the MVP.

---

## 12. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| LLM generates incorrect SQL | Wrong data shown to business users | Confidence levels, thumbs-down feedback, analyst review pipeline |
| Runaway BigQuery costs | Unexpected charges | 5-layer validation, cost gate, maximumBytesBilled, per-user quotas |
| Slack 3-second timeout exceeded | Bot appears broken | min-instances=1, CPU boost, immediate ack pattern |
| Schema drift (dbt changes) | Stale metadata leads to bad SQL | Auto-refresh on dbt CI completion, fallback to INFORMATION_SCHEMA |
| LLM API outage | Bot cannot respond | Graceful degradation message, multi-provider failover via AI SDK |
| PII exposure in query results | Compliance violation | Dataset-level permissions, column-level masking, no result data in logs |
