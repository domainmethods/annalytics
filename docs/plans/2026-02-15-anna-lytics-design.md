# Anna Lytics - Design Document

**Date**: 2026-02-15
**Status**: Approved

---

## 1. Product Overview

Anna Lytics is a Slack bot that enables business users to query a BigQuery data warehouse using natural language. It uses dbt metadata as a rich semantic layer, supports adaptive response formats, and is designed for extensibility toward Dataproc/PySpark and Databricks pipelines.

### MVP Persona

Non-technical business stakeholders (<50 users) who currently ask the data team for ad-hoc queries. Anna Lytics lets them self-serve in Slack.

### Phasing Strategy

The system is delivered in phases, each adding standalone value. Phase 0 gets the bot answering questions in Slack. Each subsequent phase is informed by real usage data from the prior phase.

#### Phase 0 — "It works" (4-6 weeks)

The minimum to get a question answered:

1. Natural-language questions → BigQuery SQL → results (read-only, auto-execute)
2. dbt metadata (manifest.json + catalog.json) as primary schema context (full schema in every prompt — no RAG needed for <30 tables)
3. Single LLM call per query (no supervisor, no clarification agent)
4. Query validation: dry run + cost gate + execution limits
5. Adaptive response format (numbers, tables, summaries)
6. Thumbs-up/down buttons (logged to Firestore, not yet acted on)
7. Basic thread context (last 4 messages)

**Goal**: Get the bot into a Slack channel answering real questions. Learn what breaks, what users ask, where accuracy falls down.

#### Phase 1 — "It's accurate" (month 1-2)

The accuracy layer, informed by Phase 0 usage:

8. **Knowledge Base (Teachings)**: Analyst-curated SQL examples and reasoning instructions, retrieved via Gemini File Search to guide sanctioned query patterns
9. **Supervisor Agent**: Second LLM pass reviewing SQL, logic, and teaching compliance — with retry loop
10. **Clarification Agent**: Smart intake with confidence classification, lightweight teaching context, and Block Kit follow-up questions
11. **In-conversation learning**: Thumbs-down + rephrase feeds negative example into next attempt
12. Gemini File Search integration (managed teaching retrieval)
13. Full 5-layer query validation pipeline
14. Sample rows in prompts (cached at dbt refresh)

#### Phase 2 — "It's trustworthy" (month 2-3)

Trust, transparency, and safety:

15. **Human-in-the-Loop Escalation**: Configurable escalation to data team channel or analyst DM, with auto-teaching from human responses
16. **Reasoning Transparency**: Persisted ResponseContext, collapsible reasoning in responses, meta-question handling ("why did you use that table?"), discrepancy investigations ("if X is Y, how come Z?")
17. **Channel-Based Access Control**: Channel-to-dataset mapping restricting which data is queryable from which channels
18. **Observability**: Structured logging with per-request trace IDs across all pipeline stages
19. Response override buttons (show as table / summary / CSV / SQL)
20. dbt run status queries (Firestore-based run history)
21. INFORMATION_SCHEMA fallback for non-dbt tables

#### Phase 3 — "It gets smarter" (month 3+)

The learning flywheel:

22. Feedback-to-teachings promotion pipeline (auto-PR from corrected patterns)
23. Teaching staleness detection (model deletion + schema diff detection)
24. Escalation rate metrics and health dashboard
25. Slack-side per-user rate limiting
26. dbt model freshness/run trend queries

### Out of Scope (all phases)

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
                         |    +-- Post status message (chat.postMessage)|
                         |    +-- async: Agent Pipeline                 |
                         |         (chat.update() after each stage)     |
                         |         |                                    |
                         |         1. Clarification Agent (Flash)       |
                         |         2. Schema retrieval (dbt metadata)   |
                         |         3. Primary Agent (Pro + File Search) |
                         |            (teachings retrieved automatically)|
                         |         4. Validation Pipeline (5-layer)     |
                         |         5. Supervisor Agent (Pro)             |
                         |            +-- retry loop (up to 2x)        |
                         |         5b. Escalation (if uncertain)        |
                         |            +-- post to data team channel/DM |
                         |            +-- persist state to Firestore   |
                         |            +-- resume on human response     |
                         |         6. Execute + format + respond        |
                         +------+-----------+-----------+---------------+
                                |           |           |
                                v           v           v
                          BigQuery   Google GenAI SDK  Firestore
                       (read-only SA) (Gemini 3.0)  (conversation
                                                     history, feedback,
                                                     + escalation state)
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
  --cpu=2 \
  --memory=1Gi \
  --concurrency=20 \
  --cpu-boost \
  --no-cpu-throttling \
  --timeout=300 \
  --region=us-central1
```

**Memory sizing rationale**: 1Gi accommodates Node.js runtime (~100MB), Bolt.js + deps (~50MB), in-memory dbt schema cache (~10-50MB depending on warehouse size), plus per-request overhead for up to 20 concurrent requests. Teaching retrieval is handled by Gemini File Search (no in-memory vector index needed), significantly reducing memory requirements. Concurrency reduced from 80 to 20 because each request makes multiple LLM calls and holds state for the full pipeline duration (5-30s). The timeout is increased to 300s to accommodate escalation flows and supervisor retry loops.

### Observability & Tracing

Every pipeline run gets a unique `traceId` (UUID) that propagates through every log line, LLM call, BigQuery job, and Firestore write. This is the single most important debugging tool — when a user reports a bad answer, the trace ID links the entire pipeline execution.

**Structured logging** (JSON to Cloud Logging via `pino`):

```typescript
interface PipelineLog {
  traceId: string;         // per-request UUID
  stage: 'clarify' | 'retrieve' | 'generate' | 'validate' | 'supervise' | 'escalate' | 'execute' | 'format';
  durationMs: number;
  // Stage-specific fields
  model?: string;          // which LLM model was called
  inputTokens?: number;    // LLM input tokens
  outputTokens?: number;   // LLM output tokens
  confidence?: string;     // agent confidence level
  verdict?: string;        // supervisor pass/fail
  bytesProcessed?: number; // BigQuery bytes
  error?: string;          // error message if stage failed
}
```

**What gets logged per stage**:

| Stage | Key metrics |
|-------|------------|
| Clarify | confidence level, route (data_query/dbt_status), latency, follow-up asked? |
| Retrieve | tables retrieved count, teachings retrieved count, latency |
| Generate | model, tokens in/out, tables used, confidence, latency |
| Validate | which layers passed/failed, dry run bytes, cost estimate |
| Supervise | verdict, retry count, teaching compliance, latency |
| Escalate | trigger reason, target (channel/DM), escalation ID |
| Execute | rows returned, bytes processed, query duration |
| Format | format chosen, result summarized?, latency |

**Trace ID propagation**: The `traceId` is stored in `ResponseContext` and included as a hidden field in the Slack message metadata. When a user reports an issue, the data team can search Cloud Logging by `traceId` to see every step of the pipeline.

**Dashboards** (Cloud Monitoring):
- **P50/P95 end-to-end latency** per phase
- **LLM cost per query** (tokens x price)
- **Supervisor retry rate** (indicates accuracy problems)
- **Escalation rate** (should trend down)
- **Error rate by stage** (which stage fails most?)
- **BigQuery bytes processed** (cost monitoring)

**Alerting**:
- Error rate >5% over 15 minutes
- P95 latency >30s
- Escalation rate >20% over 24h (system not learning)
- Memory usage >80% of limit

---

## 3. Core Request Flow

```
User: "Show me revenue"
                    |
                    v
    +--- 1. Receive + Ack ------------------+
    |   - Bolt.js receives Slack event       |
    |   - ack() immediately                  |
    |   - Post status message via            |
    |     chat.postMessage (captures msg ts) |
    |   - All subsequent stages update this  |
    |     message in-place via chat.update() |
    +----------------+-----------------------+
                     v
    +--- 2. Clarification Agent -------------+
    |   - Classify question confidence       |
    |   - HIGH: proceed immediately          |
    |   - MEDIUM: proceed with stated        |
    |     assumptions ("Assuming all regions, |
    |     last 12 months...")                |
    |   - LOW: ask targeted follow-up        |
    |     questions in Slack thread           |
    |     ("Which revenue metric? Which      |
    |     time period? Which region?")        |
    |   - Wait for user response if needed   |
    +----------------+-----------------------+
                     v
    +--- 3. Schema Retrieval ----------------+
    |   - Load dbt metadata for relevant     |
    |     tables (full schema for <30 tables,|
    |     or top 5-15 via File Search)       |
    |   - Load sample rows from Firestore    |
    +----------------+-----------------------+
                     v
    +--- 4. SQL Generation (Primary Agent) --+
    |   - Gemini 3.0 Pro + File Search tool  |
    |   - System prompt with:                |
    |     - BigQuery SQL rules               |
    |     - Table DDLs + column descriptions |
    |     - Sample rows                      |
    |   - File Search auto-retrieves         |
    |     relevant teachings and grounds     |
    |     the response with citations        |
    |   - Structured output via Zod:         |
    |     { sql, explanation, confidence,    |
    |       assumptions, reasoning_chain }   |
    +----------------+-----------------------+
                     v
    +--- 5. Validation Pipeline -------------+
    |   L1: Static pattern blocking          |
    |   L2: AST parse (node-sql-parser)      |
    |   L3: BigQuery dry run (FREE)          |
    |   L4: Cost gate (max 10GB default)     |
    |   - If any layer fails -> self-correct |
    |     (retry up to 2x with error msg)    |
    +----------------+-----------------------+
                     v
    +--- 6. Supervisor Agent ----------------+
    |   - Reviews: SQL correctness, logic,   |
    |     explanation, alignment with         |
    |     teachings/governance rules          |
    |   - PASS: proceed to execution         |
    |   - FAIL: send critique back to        |
    |     Primary Agent for regeneration     |
    |     (up to 2 retry rounds)             |
    |   - EXHAUSTED: escalation decision     |
    |     (see step 6b)                      |
    +----------------+-----------------------+
                     v
    +--- 6b. Escalation Decision -----------+
    |   Has a plausible answer?             |
    |                                       |
    |   YES (best-effort + verify):         |
    |   - Show answer with visible caveat   |
    |   - Escalate to data team for         |
    |     verification (async)              |
    |   - If data team corrects: update     |
    |     original thread + auto-generate   |
    |     teaching candidate                |
    |                                       |
    |   NO (park + escalate):               |
    |   - Tell user: "I've asked the data   |
    |     team — I'll reply here when I     |
    |     have the answer"                  |
    |   - Escalate with specific question   |
    |   - On human response: resume         |
    |     pipeline from step 4              |
    |                                       |
    |   Note: Also triggered mid-pipeline   |
    |   when agent hits specific ambiguity  |
    |   it can articulate (e.g., "two       |
    |   revenue tables — which one?")       |
    +----------------+-----------------------+
                     v
    +--- 7. Execute ----------------------------+
    |   - Run query (30s timeout, 1K rows)      |
    |   - Persist ResponseContext to Firestore   |
    |     (SQL, reasoning, assumptions, results) |
    +----------------+--------------------------+
                     v
    +--- 8. Format + Respond -------------------+
    |   - Summarize large results (Flash, only  |
    |     if >20 rows and summary format)       |
    |   - SQL shown inline (not hidden)         |
    |   - Adaptive formatting with override     |
    |     buttons: [Table] [Summary] [CSV]      |
    |     [👍] [👎]                             |
    |   - Collapsible reasoning section         |
    |   - Include supervisor caveat if low      |
    |     confidence                            |
    |   - Zero rows: hypothesis + broaden offer |
    |   - Truncated: show count + CSV download  |
    |   - Log to feedback store                 |
    +-------------------------------------------+
```

---

## 4. LLM Layer

### SDK: Google GenAI (`@google/genai`)

The Google GenAI SDK is the official TypeScript client for the Gemini API:
- Native Zod support for structured output (constrained decoding, not post-parse)
- File Search tool built in (managed RAG — see section 6)
- Progressive status updates via `chat.update()` (see section 14)
- Single Google dependency — no separate embedding or vector DB SDKs

**Auth note**: File Search stores require the Gemini Developer API with an API key — not Vertex AI, not service account ADC. The API key is managed via Secret Manager and injected as `GEMINI_API_KEY` env var on Cloud Run. All other GCP services (BigQuery, Firestore) use service account ADC as normal. This is a Google-side limitation of File Search, not an architectural choice.

### Model Strategy

| Task | Model | Pricing (per 1M tokens) | Rationale |
|------|-------|------------------------|-----------|
| SQL generation (Primary Agent) | Gemini 3.0 Pro | $2.00 in / $12.00 out | Strong reasoning for text-to-SQL, native File Search integration |
| Supervisor Agent | Gemini 3.0 Pro | $2.00 in / $12.00 out | Needs strong reasoning to catch errors in generated SQL |
| Clarification + routing | Gemini 3.0 Flash | $0.50 in / $3.00 out | Fast, cheap classification. Single call for confidence + routing. |
| Result summarization | Gemini 3.0 Flash | $0.50 in / $3.00 out | Turn tabular results into natural language |

### Structured Output Pattern

```typescript
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const response = await ai.models.generateContent({
  model: 'gemini-3.0-pro',
  contents: userQuestion,
  systemInstruction: systemPromptWithSchemaContext,
  config: {
    responseMimeType: 'application/json',
    responseSchema: z.object({
      sql: z.string().describe('The BigQuery SQL query'),
      explanation: z.string().describe('Plain-English explanation'),
      tables_used: z.array(z.string()),
      confidence: z.enum(['high', 'medium', 'low']),
      assumptions: z.array(z.string()).describe('Assumptions made about the question'),
      reasoning_chain: z.string().describe('Step-by-step reasoning for how the SQL was derived'),
    }),
    // File Search tool for teaching retrieval (see section 6)
    tools: [{
      fileSearch: {
        fileSearchStoreNames: [teachingsStoreId],
      },
    }],
  },
});

const result = JSON.parse(response.text);
const citations = response.candidates[0].groundingMetadata?.groundingChunks;
```

**Spike required**: The composition of `responseSchema` (structured JSON output) and `tools: [{ fileSearch }]` in a single `generateContent` call must be validated before Phase 1 implementation. If they don't compose, use a **two-call fallback**:

1. Call Gemini with File Search only (no structured output) — retrieve relevant teaching chunks
2. Extract `groundingMetadata` citations from the response
3. Call Gemini with structured output only (no File Search) — inject teaching chunks as text in the system prompt, generate SQL

The two-call pattern costs ~$0.004 extra per query (one additional Flash call for retrieval) and adds ~500ms latency. The pipeline logic is identical — only the LLM call site changes.

### Accuracy Expectations

State-of-the-art benchmarks (BIRD) show 71-77%. With a curated dbt semantic layer + Gemini File Search for teaching retrieval + domain-specific tuning, expect 75-90% accuracy on common query patterns. Gemini 3.0 Pro's strong reasoning capabilities and native tool use make it well-suited for text-to-SQL with grounding. The bot should clearly communicate confidence levels and gracefully handle cases where it cannot generate a reliable query.

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

TEACHINGS:
(Relevant teachings are automatically retrieved via Gemini File Search
from the teachings store. The model receives sanctioned SQL patterns
and reasoning instructions as grounded context with citations.
See section 6 for details.)

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
- **>30 tables**: Upload table descriptions to a second File Search store, retrieve top 5-15 relevant tables per query
- **Sweet spot**: 5-15 relevant tables retrieved dynamically

### Sample Rows Strategy

Sample rows add +6 accuracy points on Spider benchmarks, making them one of the highest-impact prompt elements. Sourcing strategy:

- **When**: Cached at dbt metadata refresh time (not queried live per request)
- **How**: `SELECT * FROM table LIMIT 5` for each mart/gold layer model, run as a batch job after `dbt build` completes
- **For partitioned tables**: Query the most recent partition (`WHERE _PARTITIONDATE >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) LIMIT 5`)
- **Storage**: Firestore collection `sample_rows`, keyed by `dataset.table_name`
- **Refresh**: Automatically on dbt CI completion (same trigger as metadata refresh). Stale sample rows (>7 days old) are flagged but still used — stale samples are better than no samples.
- **Cost**: One-time batch of ~30 queries at refresh time. Each scans minimal data due to LIMIT 5. Negligible cost.
- **Per-table budget**: 5 rows, truncated to 500 chars per cell to avoid blowing up prompt tokens on text columns

### Advanced Techniques (Phase 1+)

- **Chain-of-thought**: For complex queries, ask the model to plan before generating SQL.
- **Self-correction loops**: On execution failure, feed the error back and retry (up to 2 attempts).

Note: Teachings with `sanctioned_sql` serve as few-shot examples. One content system, not two. Teaching retrieval is handled by Gemini File Search (section 6) — no manual RAG pipeline needed.

---

## 6. Knowledge Base (Teachings)

The Knowledge Base is a curated collection of sanctioned SQL queries, reasoning instructions, and business definitions that guide the agent toward consistent, governance-compliant answers. It serves dual purposes: improving accuracy through few-shot examples and enforcing organizational data standards.

### What a Teaching Contains

```yaml
# teachings/revenue-metrics.yml
teachings:
  - id: revenue-monthly
    question_patterns:
      - "monthly revenue"
      - "revenue by month"
      - "MRR"
    sanctioned_sql: |
      SELECT
        DATE_TRUNC(order_date, MONTH) AS month,
        SUM(total_amount) AS revenue
      FROM `analytics.fct_orders`
      WHERE order_status = 'completed'
      GROUP BY 1
      ORDER BY 1 DESC
    reasoning: |
      Revenue always uses fct_orders with order_status = 'completed'.
      Never include cancelled or refunded orders.
      The canonical revenue metric is total_amount, not subtotal.
    models_referenced:
      - analytics.fct_orders
    tags: [revenue, finance]
    author: jane@company.com
    updated: 2026-02-10

  - id: churn-definition
    question_patterns:
      - "churn"
      - "churned customers"
      - "customer churn rate"
    sanctioned_sql: null  # reasoning-only teaching
    reasoning: |
      A customer is considered "churned" if they have had no completed
      orders in the last 90 days. Use dim_customers.last_order_date
      compared to CURRENT_DATE(). Churn rate = churned / total active
      customers at start of period.
    models_referenced:
      - analytics.dim_customers
      - analytics.fct_orders
    tags: [churn, customers]
```

### Teaching Types

| Type | Purpose | Example |
|------|---------|---------|
| **Sanctioned SQL** | Exact query pattern for a known question | "Monthly revenue" always uses this specific query |
| **Reasoning instruction** | How to think about a concept (no exact SQL) | "Churn means no orders in 90 days" |
| **Business definition** | Canonical meaning of a business term | "'Active user' = logged in within last 30 days" |
| **Anti-pattern** | What NOT to do | "Never join fct_orders directly to raw_events" |

### Source of Truth: Git

Teachings live as YAML files in the dbt repo (or the Anna Lytics repo):

```
anna_lytics/
  teachings/
    revenue-metrics.yml
    customer-definitions.yml
    anti-patterns.yml
```

**Why Git**: Version control, PR review, blame history, audit trail. Teachings are governance artifacts — they should be reviewed the same way data model changes are.

### Authoring via Slack (Convenience Layer — Phase 1)

`/anna teach` opens a Slack modal with fields for:
- Business question (natural language)
- Sanctioned SQL (optional)
- Reasoning / instructions
- Tags

On submission, the bot auto-creates a PR in the repo via GitHub API. Once merged, CI syncs teachings to the File Search store.

### Teaching Retrieval via Gemini File Search

Instead of building a custom embedding + vector search + BM25 pipeline, teaching retrieval uses **Gemini File Search** — a fully managed RAG system built into the Gemini API. File Search handles chunking, embedding (via `gemini-embedding-001`), vector search, and context injection automatically.

**How it works**:

1. **Indexing** (CI, on teaching change):
   - Each teaching is converted from YAML to a **standalone markdown document** before upload — one file per teaching, not one YAML file per category. Markdown embeds better for semantic search and avoids File Search chunking splitting a SQL block mid-query:
     ```markdown
     # Teaching: revenue-monthly
     Tags: revenue, finance | Models: analytics.fct_orders

     ## Question Patterns
     - monthly revenue
     - revenue by month
     - MRR

     ## Sanctioned SQL
     SELECT DATE_TRUNC(order_date, MONTH) AS month,
       SUM(total_amount) AS revenue
     FROM `analytics.fct_orders`
     WHERE order_status = 'completed'
     GROUP BY 1 ORDER BY 1 DESC

     ## Reasoning
     Revenue always uses fct_orders with order_status = 'completed'.
     Never include cancelled or refunded orders.
     The canonical revenue metric is total_amount, not subtotal.
     ```
   - Each teaching file is ~100-300 tokens — small enough that File Search keeps it in a single chunk, eliminating the risk of split SQL
   - Synthetic question expansion: before upload, a CI step uses Gemini Flash to generate 10-20 realistic question variants per teaching and appends them to the file — File Search embeds these alongside the original content, improving retrieval recall
   - File Search automatically chunks, embeds, and indexes the content
   - Initial indexing cost: $0.15/M tokens (~$0.01 for 50 teaching files)

2. **Query time** (automatic, no code):
   - The Primary Agent's Gemini call includes `fileSearch` as a tool pointing to the teachings store (see section 4 code example)
   - Gemini automatically retrieves relevant teaching chunks and grounds its response
   - The response includes `groundingMetadata` with citations linking back to specific teaching files and chunks
   - Storage and query-time embeddings are **free** — no per-query retrieval cost

3. **Citations for transparency**:
   - Each citation includes the source file, chunk text, and relevance score
   - Citations are persisted in `ResponseContext` for meta-question handling (section 11)
   - The Supervisor Agent receives the cited teaching chunks to verify compliance

```typescript
// CI: Sync teachings to File Search store
async function syncTeachingsToFileSearch(teachings: Teaching[]) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  for (const teaching of teachings) {
    // Generate synthetic questions for better retrieval
    const syntheticQs = await generateSyntheticQuestions(teaching);

    // Build enriched document content
    const content = formatTeachingForFileSearch(teaching, syntheticQs);

    // Upload to File Search store
    await ai.fileSearchStores.uploadToFileSearchStore({
      fileSearchStoreName: TEACHINGS_STORE_ID,
      file: Buffer.from(content),
      config: {
        displayName: teaching.id,
        customMetadata: {
          tags: teaching.tags.join(','),
          models: teaching.models_referenced.join(','),
        },
      },
    });
  }
}
```

**Why File Search over custom RAG**:
- **Zero infrastructure**: No hnswlib, no BM25 index, no embedding model to manage, no vector DB
- **Free at query time**: Storage and retrieval embeddings are free; only initial indexing costs ($0.15/M tokens)
- **Built-in citations**: Grounding metadata comes back automatically — perfect for our transparency requirements
- **Scales automatically**: No memory pressure on Cloud Run, no index rebuild on cold start
- **Trade-off**: Less control over ranking/scoring than a custom pipeline, but for an MVP with <100 teachings this is a net win

**Graceful degradation**: If File Search fails (API error, empty store, indexing incomplete), the pipeline retries the Primary Agent call without the `tools` config — generating SQL from schema context alone, same as Phase 0. The failure is logged with the trace ID for alerting. Teaching-less responses are marked `confidence: medium` at most, since they lack governance grounding.

**File Search store lifecycle**:
- One store: `anna-lytics-teachings`
- Synced from Git on CI (GitHub Actions step after teaching PR merge)
- Stale teachings (Level 1, model_missing) are removed from the store during sync
- Schema-drift warnings (Level 2) are appended as metadata to the teaching file
- **Phase 0**: No teachings exist, File Search `tools` config is omitted from the Gemini call. Primary Agent generates SQL from schema context alone.

**Teaching summary map** (for Clarification Agent, section 8): During the same CI sync step that uploads to File Search, the pipeline also reads the raw YAML files from Git and writes a `TeachingSummary[]` array to a Firestore document (`config/teaching_summaries`). The Clarification Agent loads this on startup — it's a flat list of terms + definitions, not a retrieval index.

### Staleness Protection

Each teaching references specific dbt models (`models_referenced`) and may contain `sanctioned_sql` referencing specific columns. Staleness detection runs on CI whenever dbt metadata refreshes:

**Level 1 — Model deletion/rename** (blocks retrieval):
- If any model in `models_referenced` no longer exists in `manifest.json`, flag teaching as `stale:model_missing`
- Stale teachings are excluded from RAG retrieval until an analyst updates them

**Level 2 — Schema drift** (warns but still retrieved):
- If a teaching has `sanctioned_sql`, parse it (AST) and extract referenced column names
- Compare against the current `catalog.json` column list for each referenced model
- If columns were dropped or renamed, flag as `stale:schema_drift` with a list of affected columns
- Schema-drift teachings are still retrieved (the reasoning may still be valid) but include a warning in the prompt: "⚠️ This teaching references columns that may have changed: {columns}"
- The Supervisor Agent treats schema-drift warnings as a review flag

**Level 3 — Semantic drift** (Phase 3, advisory):
- If a model's `description` changed significantly since the teaching was authored (cosine similarity of description embeddings drops below threshold), flag as `stale:semantic_drift`
- This catches cases where a model's *meaning* changes without column-level schema changes (e.g., `fct_orders` is redefined to include refunded orders)
- Advisory only — surfaces in a weekly digest to the data team, not enforced automatically

**CI implementation**: A GitHub Actions step after `dbt docs generate` runs a comparison script:
1. Load all teachings from the repo
2. Load current `manifest.json` + `catalog.json`
3. For each teaching, run Level 1 and Level 2 checks
4. Update staleness flags in Firestore (used by RAG retrieval)
5. If any teachings are newly stale, post a summary to the escalation channel

### Governance Effect

Teachings act as soft governance: the agent is strongly guided toward sanctioned patterns but can still generate novel SQL for questions without teachings. The Supervisor Agent (section 7) checks whether the generated SQL aligns with relevant teachings when they exist. When no teachings exist and the agent is uncertain, Human-in-the-Loop Escalation (section 10) kicks in — and the human response bootstraps new teachings organically.

---

## 7. Supervisor Agent

The Supervisor Agent is a second LLM pass that reviews the Primary Agent's output before it reaches the user. It checks SQL correctness, logical soundness, alignment with teachings, and the quality of the explanation.

### What the Supervisor Reviews

| Check | Description |
|-------|-------------|
| **SQL correctness** | Does the SQL look syntactically and semantically correct for the question asked? |
| **Logic alignment** | Does the reasoning chain make sense? Are the right tables and joins used? |
| **Teaching compliance** | If relevant teachings exist, does the SQL follow the sanctioned patterns? |
| **Assumption validity** | Are the stated assumptions reasonable for the question? |
| **Completeness** | Does the SQL actually answer what was asked, or does it answer a different question? |
| **Safety** | Any signs of unbounded queries, missing filters, or potential cost issues? |

### Supervisor Prompt Structure

```
You are a senior data analyst reviewing a generated SQL query.

ORIGINAL QUESTION: {user_question}
CLARIFIED QUESTION: {clarified_question_with_assumptions}

RELEVANT TEACHINGS (from Primary Agent's File Search citations):
{grounding_citation_chunks}

GENERATED SQL:
{primary_agent_sql}

EXPLANATION:
{primary_agent_explanation}

REASONING CHAIN:
{primary_agent_reasoning}

REVIEW CHECKLIST:
1. Does the SQL correctly answer the question?
2. Are the right tables and columns used?
3. If teachings exist for this topic, does the SQL follow them?
4. Are the joins correct?
5. Are there missing WHERE clauses or filters that should exist?
6. Is the explanation accurate and matches the SQL?

Respond with:
{
  "verdict": "PASS" | "FAIL",
  "confidence": "high" | "medium" | "low",
  "issues": ["list of specific issues found"],
  "suggestions": ["specific fixes if FAIL"],
  "teaching_compliance": "compliant" | "deviated" | "no_relevant_teaching"
}
```

### Retry Loop

```
Primary Agent generates SQL + explanation
    |
    v
Supervisor reviews
    |
    +-- PASS --> proceed to execution
    |
    +-- FAIL (round 1) --> send critique + suggestions to Primary Agent
                |
                v
         Primary Agent regenerates with feedback
                |
                v
         Supervisor reviews again
                |
                +-- PASS --> proceed to execution
                |
                +-- FAIL (round 2) --> send critique to Primary Agent
                            |
                            v
                     Primary Agent regenerates
                            |
                            v
                     Supervisor reviews (final)
                            |
                            +-- PASS --> proceed
                            +-- FAIL --> proceed with LOW confidence caveat
```

Maximum 2 retry rounds (3 total supervisor calls). If still failing after exhaustion, the answer is shown to the user with a visible caveat:

> "I'm not fully confident in this answer. [Supervisor note: The query may be using the wrong revenue metric. Consider verifying with the data team.]"

### Teaching Context for the Supervisor

The Supervisor doesn't use File Search — it receives teaching context extracted from the Primary Agent's response. After the Primary Agent generates SQL, the pipeline extracts `groundingMetadata.groundingChunks` (the teaching chunks File Search retrieved) and injects them into the Supervisor prompt as `RELEVANT TEACHINGS`.

Since each teaching is uploaded as a standalone markdown document (~100-300 tokens), each grounding chunk is a complete teaching — not a truncated fragment. The Supervisor sees the full sanctioned SQL, reasoning, and question patterns for every teaching the Primary Agent used.

### Cost Considerations

The Supervisor adds 1-3 extra LLM calls per query. To manage costs:
- Use the same model tier as the Primary Agent (Gemini 3.0 Pro) — the supervisor needs strong reasoning
- The supervisor prompt is smaller than the primary prompt (no schema DDL, just the SQL + explanation + cited teachings to review)
- Average case: 1 supervisor call (PASS on first try). Retries are the exception.
- Consider making the supervisor optional per channel or per user preference for cost-sensitive deployments

---

## 8. Clarification Agent

The Clarification Agent runs before SQL generation to ensure the bot has enough information to answer the user's actual intent, not just the surface-level question.

### Smart Threshold Approach

The agent classifies each incoming question into one of three confidence levels:

| Confidence | Action | Example |
|------------|--------|---------|
| **HIGH** | Answer immediately, no clarification needed | "How many orders were placed yesterday?" |
| **MEDIUM** | Answer with prominently stated assumptions + quick-recovery button | "Show me revenue" → assumptions shown as **first line of response, bold, above results**: "**Assuming: all regions, completed orders only, last 12 months**" + `[Wrong assumptions? Click to refine]` button that pre-populates a refinement. No confirmation gate before execution — the recovery path (one click + one sentence) is fast enough, and asking "are you sure?" on 60%+ of queries would kill adoption. |
| **LOW** | Ask 1-2 targeted clarifying questions before proceeding | "How are we doing?" -> "Could you clarify: are you asking about revenue, customer growth, or something else?" |

### Lightweight Teaching Context

The Clarification Agent runs *before* the Primary Agent (which has File Search for teaching retrieval), so it cannot access full teachings. To avoid making assumptions blind, it receives a **teaching summary map** — a flat lookup of canonical definitions loaded from Firestore at startup (populated by CI — see section 6):

```typescript
// Built once when teachings are indexed, updated on CI
interface TeachingSummary {
  term: string;           // e.g., "revenue"
  definition: string;     // e.g., "total_amount from fct_orders, completed orders only"
  canonical_table: string; // e.g., "analytics.fct_orders"
}

// Injected into clarification prompt as AVAILABLE CONTEXT
const teachingSummaries: TeachingSummary[] = teachings.map(t => ({
  term: t.tags[0],
  definition: t.reasoning.split('\n')[0], // first sentence only
  canonical_table: t.models_referenced[0],
}));
```

This gives the Clarification Agent enough domain knowledge to make informed assumptions ("Assuming 'revenue' means total_amount from fct_orders, completed orders only") without duplicating full RAG retrieval. The full teachings with sanctioned SQL are retrieved automatically by File Search during the Primary Agent call (step 4).

### Classification Prompt

```
You are a data analyst intake specialist. Evaluate whether the
following question has enough specificity to generate an accurate
SQL query against our data warehouse.

AVAILABLE CONTEXT (canonical business definitions):
- Business terms we know: {teaching_summary_map}
- Common metrics: {list_of_known_metrics}

USER QUESTION: {question}
THREAD CONTEXT: {previous_messages_in_thread}

Classify and respond:
{
  "route": "data_query" | "dbt_status",
  "confidence": "high" | "medium" | "low",
  "reasoning": "why this confidence level",
  "ambiguities": ["list of unclear aspects"],
  "assumptions": ["assumptions that could be stated if medium"],
  "clarifying_questions": ["targeted questions to ask if low"],
  "resolved_question": "the question restated with full clarity (if high/medium)"
}
```

### Clarification UX in Slack

When the Clarification Agent needs to ask follow-up questions, it posts in the thread:

```
I want to make sure I get this right. A couple of quick questions:

1. **Which revenue metric?**
   - Total revenue (all orders)
   - Net revenue (excluding refunds)
   - MRR (monthly recurring)

2. **What time period?**
   - Last month
   - Last 12 months
   - Year-to-date

Reply with your choices, or just say "all revenue, last 12 months" etc.
```

The bot uses Block Kit buttons for common choices (fast click) with a text fallback for custom answers.

### LOW Confidence: Async Wait via Firestore

When the Clarification Agent classifies a question as LOW confidence and posts follow-up questions, the pipeline must **suspend and resume** across separate Slack events — the same pattern as escalation (section 10). The Cloud Run request that posted the clarification question ends; a new request arrives when the user replies.

**State machine** (Firestore collection: `clarification_state`):

```
1. Clarification Agent classifies question as LOW
2. Post clarifying questions to Slack thread (Block Kit buttons + text)
3. Persist state to Firestore:
   {
     clarificationId: string,
     threadTs: string,
     channel: string,
     originalQuestion: string,
     ambiguities: string[],       // what we asked about
     clarifyingMessageTs: string, // ts of our follow-up message
     state: 'awaiting_reply',
     createdAt: Date,
     expiresAt: Date,             // 1 hour TTL
   }
4. Return (Cloud Run request ends)

--- user replies (seconds/minutes later) ---

5. Bolt.js receives message event in thread
6. Check Firestore for pending clarificationId matching threadTs
7. Load clarification state
8. Merge user's reply into clarified question
9. Delete clarification state from Firestore
10. Resume pipeline at step 3 (Schema Retrieval → Primary Agent)
```

**Timeout**: If the user doesn't reply within 1 hour, the clarification state is treated as expired. **Important**: Firestore TTL deletion is eventually consistent (Google's SLA is "within 24 hours"), so the application must NOT rely on document absence to mean expiration. Instead, the handler always checks `expiresAt` explicitly:

```typescript
const state = clarificationDoc.data();
if (state.expiresAt.toDate() < new Date()) {
  // Expired — treat as fresh question, ignore stale state
  await clarificationDoc.ref.delete(); // clean up eagerly
  return handleFreshQuestion(event);
}
// Not expired — resume pipeline with clarification
```

Firestore TTL is used only as a background cleanup mechanism for documents the application missed, not as a correctness guarantee.

**Button responses**: Block Kit button clicks arrive as `block_actions` events, not messages. The handler matches the `action_id` to the `clarificationId` and resumes the pipeline with the selected option.

Once the user responds, the clarified question flows into Schema Retrieval and SQL Generation.

### Thread Context Awareness

The Clarification Agent considers thread context to avoid redundant clarification. If the user has already been discussing customer churn, a follow-up like "now show me by region" doesn't need clarification — the agent infers the topic from history.

**Token budget**: Thread context is capped at **2,000 tokens** to prevent long conversations from blowing up prompt size and cost. Strategy:

1. **Always include**: The last 4 messages (2 user + 2 bot) — the immediate conversational context
2. **Summarize the rest**: If thread exceeds 4 messages, compress earlier messages into a 1-2 sentence summary: "Earlier in this thread, the user asked about customer churn rates by region. Results showed 12% overall churn."
3. **Strip SQL results**: Bot responses that contain query results are replaced with a stub: "[Query result: 15 rows, columns: region, churn_rate, customer_count]" — the full results are in `ResponseContext` if needed
4. **Hard cap**: If compressed context still exceeds 2,000 tokens, truncate oldest-first

```typescript
const thread = await client.conversations.replies({
  channel, ts: thread_ts, oldest: thread_ts,
});

const threadContext = buildThreadContext(thread.messages!, {
  maxTokens: 2000,
  recentMessageCount: 4,
  summarizeOlder: true,
  stripQueryResults: true,
});
```

### When NOT to Clarify

- User explicitly says "just guess" or "best guess is fine"
- The question matches a Teaching exactly (sanctioned query exists)
- Follow-up in a thread where the topic is already established
- Simple, unambiguous questions ("how many X yesterday?")

---

## 9. Agent Pipeline Summary

The agents form a pipeline with distinct roles. Teaching retrieval is not a separate step — it happens automatically inside the Primary Agent via File Search:

```
User Question
    |
    v
[Clarification Agent] -- "Do I understand the question?"
    |                     Uses: Gemini 3.0 Flash (cheap, fast)
    |                     Output: clarified question + assumptions
    v
[Primary Agent] -------- "Generate the SQL"
    |                     Uses: Gemini 3.0 Pro + File Search tool
    |                     File Search retrieves teachings automatically
    |                     Input: schema + clarified question
    |                     Output: SQL + explanation + reasoning chain
    |                             + grounding citations
    v
[Validation Pipeline] -- "Is the SQL safe to run?"
    |                     5-layer technical validation
    v
[Supervisor Agent] ----- "Is the answer correct and compliant?"
    |                     Uses: Gemini 3.0 Pro
    |                     Input: SQL + cited teachings from Primary
    |                     Checks: correctness, teaching compliance, logic
    |                     Can: retry Primary Agent up to 2x
    |
    +-- If exhausted or mid-pipeline ambiguity:
    |
[Escalation] ----------- "Ask a human"
    |                     Posts specific question to data team
    |                     Best-effort + verify OR park + wait
    |                     Human response -> teaching candidate
    v
[Execute] -------------- "Run the query"
    |                     BigQuery execution with limits
    v
[Format + Summarize] --- "Present the answer"
    |                     Uses: Gemini 3.0 Flash for large result summaries
    |                     Adaptive format (table/text/CSV)
    |                     User can override via buttons
    |                     Persist ResponseContext to Firestore
    v
[Respond] -------------- "Deliver to user"
    |                     Post to Slack with reasoning + override buttons
    |                     [📋 Table] [📝 Summary] [⬇️ CSV] [👍] [👎]
```

### Confidence Reconciliation

Three agents independently assess confidence, each measuring something different:

| Agent | Measures | Values | Used For |
|-------|----------|--------|----------|
| Clarification Agent | **Question clarity** — is the question specific enough? | HIGH / MEDIUM / LOW | Internal routing only (proceed / assume / ask). Never shown to user. |
| Primary Agent | **Answer certainty** — how confident is the model in its SQL? | high / medium / low | Input to user-facing confidence |
| Supervisor Agent | **Correctness assurance** — does the SQL pass review? | high / medium / low | Input to user-facing confidence |

**User-facing confidence** (stored as `ResponseContext.confidence`): `min(supervisor, primaryAgent)`. If the Primary Agent is confident but the Supervisor is uncertain, the user sees the lower value. The Clarification Agent's confidence is never surfaced — it's a routing decision, not a quality signal.

All three values are stored in `ResponseContext` for debugging and observability, but the response and escalation logic use only the reconciled value.

### Cost per Query (Estimated)

**Token budget reality check**: The Primary Agent prompt includes schema DDL (500-2,000 tokens/table x 5-15 tables), sample rows, thread context, and instructions. Expect **15,000-50,000 input tokens** of schema context per Primary Agent call depending on warehouse size. File Search injects an additional **~2,000-5,000 input tokens** of teaching context (3-5 retrieved teachings at ~300-1,000 tokens each) — these count toward the input token cost. Total input per call: ~17,000-55,000 tokens. At Gemini 3.0 Pro pricing ($2.00/M input, $12.00/M output), a single generation call costs ~$0.03-0.11 in input + ~$0.01-0.05 in output.

#### By Phase

| Phase | Scenario | LLM Calls | Approx Cost | Monthly (50 users x 10 q/day) |
|-------|----------|-----------|-------------|-------------------------------|
| **0** | Single Pro call, no agents | 1 (Pro: generate only) | ~$0.04-0.15 | ~$600-2,250 |
| **1** | Happy path (supervisor passes) | 1 Flash + 2 Pro (clarify + generate + supervise) | ~$0.08-0.25 | ~$1,200-3,750 |
| **1** | Supervisor retry (1 round) | 1 Flash + 4 Pro | ~$0.15-0.40 | — |
| **2** | + meta-question follow-up | 1 (Flash, no SQL) | ~$0.002 | negligible |
| **2** | + discrepancy investigation | 2-3 Pro (diagnostic SQL) | ~$0.04-0.15 | — |

**Cost management levers**:
- Phase 0 keeps costs low by using a single LLM call — no supervisor or clarification overhead
- Gemini 3.0 Pro ($2/M in, $12/M out) is cost-effective for multi-call pipelines
- Clarification and summarization use Flash (~$0.002/call) — negligible
- File Search retrieval is free at query time — no per-query embedding cost
- Supervisor is the biggest cost multiplier; consider making it optional per channel in cost-sensitive deployments
- Prompt token budget: cap schema context at 15 tables max, truncate DDLs to essential columns
- Monitor actual costs from Phase 0 before committing to Phase 1 agent architecture

---

## 10. Human-in-the-Loop Escalation

When the agent is uncertain — either mid-pipeline (ambiguous schema, conflicting tables) or after supervisor exhaustion — it escalates a **specific, answerable question** to a human expert rather than guessing.

### Escalation Target (Configurable)

The escalation target is set via environment config and can be changed at any time:

```typescript
interface EscalationConfig {
  mode: 'channel' | 'dm';
  // Channel mode: posts to a shared channel (e.g., #anna-lytics-escalations)
  channelId?: string;
  // DM mode: messages a specific analyst directly
  analystUserId?: string;
  // How long to wait before reminding (minutes)
  reminderIntervalMinutes: number;  // default: 30
  // How long before giving up and showing best-effort with caveat (hours)
  timeoutHours: number;  // default: 4
}
```

**Channel mode**: The data team joins a dedicated channel (e.g., `#data-team-escalations`). Any team member can respond. Best for teams where on-call rotates or multiple people can answer.

**DM mode**: A specific analyst receives escalations as DMs from the bot. Best for small teams with a single point of contact.

### When Escalation Triggers

| Trigger | Behavior | Example |
|---------|----------|---------|
| **Mid-pipeline ambiguity** | Agent detects a specific decision it can't make | "There are two revenue tables: `fct_orders` and `fct_subscriptions`. Which one is canonical for 'total revenue'?" |
| **Supervisor exhausted (has plausible answer)** | Best-effort + verify: show answer with caveat, escalate async for verification | "I used `fct_orders` but I'm not fully sure. Here's what I got — I've asked the data team to verify." |
| **Supervisor exhausted (no plausible answer)** | Park + escalate: tell user the bot is checking with the data team | "I want to make sure I get this right. I've asked the data team — I'll reply here when I have the answer." |
| **Unanswerable question** | Agent determines the question can't be answered with available data | "This looks like a forecasting question — I can only query historical data. I've flagged this for the data team." |

### Escalation Message Format

The bot posts to the escalation target with full context:

```
🔔 Anna Lytics needs help

**User question**: "Show me total revenue by region"
**Channel**: #sales (thread link)
**What I'm stuck on**: There are two tables with revenue data:
  - `analytics.fct_orders` (has `total_amount`, `region`)
  - `analytics.fct_subscriptions` (has `mrr`, `region`)
Which table should I use for "total revenue"?

**My best guess**: `fct_orders.total_amount` — but no teaching exists for this.

React with ✅ if my guess is correct, or reply with guidance.
```

### State Machine for Async Resumption

Escalation requires suspending and resuming the pipeline across separate Slack events:

```
1. Pipeline hits escalation trigger
2. Persist pipeline state to Firestore:
   {
     escalationId: string,
     originalThreadTs: string,
     originalChannel: string,
     pipelineState: 'awaiting_human',
     stageToResume: 'sql_generation' | 'supervisor_review',
     context: { clarifiedQuestion, groundingCitations, ... },
     escalationTs: string,  // ts of the message in escalation channel
     createdAt: Date,
   }
3. Post escalation message to target channel/DM
4. Return (Cloud Run request ends)

--- human responds (minutes/hours later) ---

5. Bolt.js receives message event in escalation channel
6. Match response to escalationId via thread_ts
7. Load pipeline state from Firestore
8. Incorporate human guidance into context
9. Resume pipeline at stageToResume
10. Post result to original user thread
11. Auto-generate teaching candidate (see below)
```

### Thread Re-Entry During Pending Escalation

While waiting for a human response to an escalation, the user may post additional messages in the original thread. The bot must not launch a new pipeline for a thread that is parked pending escalation.

**Implementation**: The message filter (section 14) checks for pending escalation state before invoking the pipeline, using the same pattern as the clarification state check:

```typescript
// In the message handler, after shouldRespond() passes:
const pendingEscalation = await db.collection('escalation_state')
  .where('originalThreadTs', '==', event.thread_ts)
  .where('pipelineState', '==', 'awaiting_human')
  .limit(1).get();

if (!pendingEscalation.empty) {
  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.thread_ts,
    text: "I'm still waiting for the data team on your previous question. I'll reply here when I have an answer.",
  });
  return;
}
```

This runs alongside the clarification state check and the thread processing lock — three guards that prevent the pipeline from launching when it shouldn't.

### Auto-Teaching from Escalations

Every human response to an escalation is a teaching candidate:

```
Human responds: "Always use fct_orders for revenue.
fct_subscriptions is only for MRR breakdowns."
    |
    v
Bot extracts structured teaching:
  - question_patterns: ["total revenue", "revenue by region"]
  - reasoning: "Revenue = fct_orders.total_amount.
    fct_subscriptions is MRR only."
  - models_referenced: [analytics.fct_orders]
    |
    v
Bot confirms with human: "I've drafted this as a teaching:
  [preview]. Want me to open a PR?"
    |
    +-- Human approves -> auto-PR to teachings repo
    +-- Human edits -> update draft, then PR
    +-- Human declines -> store as one-off context only
```

This is how the Knowledge Base bootstraps organically. The data team never has to write YAML from scratch — they answer questions they'd answer anyway, and the bot turns their answers into durable teachings.

### Escalation Rate as Health Metric

The escalation rate should **decrease over time** as the Knowledge Base grows. Track:

- **Escalation rate**: % of queries that trigger escalation (target: <10% after 3 months)
- **Repeat escalations**: Same question type escalated twice = missing teaching (alert)
- **Response time**: Median time for human to respond (tracks data team engagement)
- **Teaching conversion rate**: % of escalations that become teachings

If the escalation rate stays flat or increases, the system is failing — the bot is not learning from human responses.

---

## 11. Reasoning Transparency & Interrogation

Business users don't just want answers — they want to understand *how* the answer was derived so they can trust it, challenge it, and refine it. Anna Lytics must support "sausage-making" conversations where users interrogate the agent's logic.

### Persisted Response Context

Every response the agent generates is persisted to Firestore with full reasoning context:

```typescript
interface ResponseContext {
  responseId: string;
  threadTs: string;
  messageTs: string;
  // What the agent did
  clarifiedQuestion: string;
  assumptions: string[];
  reasoningChain: string;
  generatedSql: string;
  tablesUsed: string[];        // table names referenced in the SQL
  teachingsUsed: string[];     // IDs of teachings that influenced the answer
  // Full dbt context (persisted from the pipeline — not fetched again)
  retrievedSchema: TableContext[];  // all 5-15 tables in the prompt, with
                                    // descriptions, column definitions, lineage,
                                    // sample DDL — including tables considered
                                    // but not used in the final SQL
  // File Search grounding (teachings retrieved by Gemini automatically)
  groundingCitations: {
    sourceFile: string;      // teaching file name in File Search store
    chunkText: string;       // the relevant chunk Gemini retrieved
    relevanceScore: number;
  }[];                       // from response.groundingMetadata
  // What happened
  supervisorVerdict: 'pass' | 'fail_then_pass' | 'exhausted';
  supervisorNotes: string;
  confidence: 'high' | 'medium' | 'low';
  queryResults: {
    rowCount: number;
    columnNames: string[];
    sampleRows: any[];  // first 5 rows for diagnostic follow-ups
    bytesProcessed: number;
  };
  // Timing
  pipelineDurationMs: number;
  createdAt: Date;
}
```

**Key insight**: The pipeline already has 5-15 tables in the prompt (with full descriptions, column definitions, lineage, sample DDL) and File Search automatically retrieves relevant teachings with citations. Instead of discarding this context after the response, persist it. This gives the agent everything it needs to answer most "sausage-making" questions without any new infrastructure — it just doesn't throw away what it already fetched.

`retrievedSchema` includes tables the agent **considered but didn't use** — this is what lets it answer "why fct_orders and not fct_subscriptions?" (both were in the prompt context, and the agent can explain why it chose one). `groundingCitations` captures which teachings File Search retrieved and what chunks were used — this lets the agent explain "I followed the Monthly Revenue teaching which says to use fct_orders with completed orders only."

This context is keyed by `threadTs + messageTs`, making it retrievable for any follow-up in the same thread.

### Follow-Up Intent Classification

When a user sends a follow-up message in a thread with a previous Anna Lytics response, the Clarification Agent classifies it into one of four intents:

| Intent | Description | Example | Action |
|--------|-------------|---------|--------|
| **New query** | Unrelated data question | "How many customers do we have?" | Full pipeline from scratch |
| **Refinement** | Modify the previous query | "Now break that down by region" | Re-run pipeline with modified question + prior context |
| **Meta-question** | Question about the agent's reasoning | "Why did you use fct_orders?" | Load ResponseContext, answer from reasoning chain |
| **Discrepancy investigation** | "If X, how come Y?" | "If total is $5M, how come Q4 is only $800K?" | Load ResponseContext + run diagnostic query |

Classification prompt addition:

```
FOLLOW-UP CLASSIFICATION:
If this message is in a thread with a prior Anna Lytics response,
also classify the follow-up intent:
{
  "follow_up_intent": "new_query" | "refinement" | "meta_question" | "discrepancy",
  ...existing fields...
}
```

### Handling Refinements

Refinements are the most common follow-up pattern ("now break that down by region", "just show last quarter", "add the customer name column"). They modify the previous query rather than asking something new.

**Strategy**: Re-run the full pipeline but seed it with context from the previous response:

1. Load the previous `ResponseContext` from Firestore
2. Construct a **composite question** that merges the refinement with the original:
   ```
   ORIGINAL QUESTION: "Show me revenue by month"
   ORIGINAL SQL: SELECT DATE_TRUNC(order_date, MONTH) AS month, SUM(total_amount) AS revenue FROM ...
   REFINEMENT: "Now break that down by region"
   COMPOSITE: "Show me revenue by month, broken down by region"
   ```
3. Feed the composite question through the normal pipeline (Schema Retrieval → Primary Agent → Validation → Supervisor)
4. The Primary Agent receives the original SQL as a **starting point** (not the answer — it's a hint):
   ```
   PREVIOUS SQL (user wants a modification):
   {original_sql}

   The user wants to refine this query. Use it as a starting point
   but generate a complete new query incorporating the refinement.
   ```

**Why re-run the full pipeline instead of just patching SQL?** String-manipulating SQL is brittle and error-prone. The LLM is better at understanding "add region" means adding both a `SELECT` column and a `GROUP BY` clause. The supervisor catches any mistakes. The cost is one extra pipeline run, but the accuracy is much higher than a regex/AST patch.

**Optimization**: The schema retrieval step can reuse the previous `retrievedSchema` (it's persisted in `ResponseContext`) rather than re-embedding and re-searching. The same tables are almost certainly relevant. This saves one embedding call and one vector search per refinement.

### Handling Meta-Questions

For meta-questions ("Why did you use fct_orders?", "What does 'completed' mean here?"), the agent loads the full `ResponseContext` — including the dbt schema context and teachings that were already retrieved during the original query — and answers directly. No SQL generation, no supervisor, just a conversational LLM call:

```
You are explaining your previous data analysis to a business user.
You have access to the full data model context that was used.

YOUR PREVIOUS RESPONSE:
Question: {clarifiedQuestion}
SQL: {generatedSql}
Assumptions: {assumptions}
Reasoning: {reasoningChain}
Supervisor assessment: {supervisorNotes}

TABLES YOU CONSIDERED (from dbt metadata):
{retrievedSchema — full descriptions, columns, lineage for all
 5-15 tables that were retrieved, including ones NOT used in SQL}

TEACHINGS REFERENCED (from File Search grounding):
{groundingCitations — source file, chunk text, relevance score}

USER FOLLOW-UP: {follow_up_question}

Explain your reasoning in plain language. Be specific about:
- WHY you chose the tables you used
- WHY you did NOT use other tables that were available
- What each column/filter means in business terms (use dbt descriptions)
- Where the data comes from (use the dependsOn lineage)
- Which teachings guided your approach and why
If you made an assumption, flag it. Do not use jargon.
```

This uses Flash (cheap, fast) since it's reasoning over context that was already fetched — no new retrieval, no SQL generation. The dbt metadata is the key: it lets the agent explain decisions in terms of the data model ("I used fct_orders because its description says it contains all completed transactions, while fct_subscriptions only tracks recurring revenue") rather than vague generalities.

### Handling Discrepancy Investigations

"If total revenue is $5M, how come Q4 only shows $800K?" requires more than explaining reasoning — it may need a **diagnostic query** to investigate.

```
1. Load ResponseContext for the previous answer
2. Parse the discrepancy: user expected X, got Y
3. Generate a diagnostic SQL query to investigate:
   - Break down the original query by the dimension in question
   - Check for filter effects ("how many rows were excluded by the
     completed-only filter?")
   - Look for data gaps ("are there NULL values in the date column?")
4. Run diagnostic query through the normal validation pipeline
5. Present findings: "The $5M total covers all of 2025. Q4 shows
   $800K because it only includes October — November and December
   haven't been loaded yet. The last data refresh was Oct 31."
```

Diagnostic queries use the Primary Agent (Gemini 3.0 Pro) but skip the Supervisor — they're investigative, not user-facing answers.

### Visible Reasoning in Responses

Every response includes the generated SQL inline (not hidden behind a button) so the user immediately sees what ran. Since the bot auto-executes queries, SQL visibility is the user's primary sanity check — hiding it behind a click means the user only discovers mistakes after the fact.

```
**Assuming: all regions, completed orders only, last 12 months**
[Wrong assumptions? Click to refine]

Total revenue last quarter: $5.2M

Query:
  SELECT DATE_TRUNC(order_date, MONTH), SUM(total_amount) FROM ...

🔍 *Show reasoning* (click to expand)

  Tables: analytics.fct_orders
  Filter: order_status = 'completed' AND order_date >= '2025-10-01'
  Guided by: "Monthly Revenue" teaching
  Confidence: high ✓
```

The assumptions line appears **first, above the results**, because the user needs to validate assumptions before trusting the answer. The `[Wrong assumptions? Click to refine]` button triggers a refinement flow (section 11) pre-populated with the original question and stated assumptions, so the user can correct with minimal effort ("I meant net revenue, not total").

**Implementation note**: Block Kit has no native client-side toggle/expand widget. "Show reasoning" is implemented as a **button action** that updates the message:

1. Initial response includes a `🔍 Show reasoning` button (Block Kit `actions` block)
2. User clicks the button → Bolt.js receives a `block_actions` event
3. Handler calls `chat.update()` on the original message, replacing the button with the full reasoning content (section blocks with the tables, filters, teachings, SQL)
4. A `🔍 Hide reasoning` button is included to toggle back

This is the standard Slack pattern for expandable content. The update is instant (no LLM call — the reasoning is already in `ResponseContext`). The trade-off is a server round-trip per toggle, but it's a single Firestore read + Slack API call (~200ms).

### Response Override Buttons

Every response includes action buttons for format control and investigation:

```
[📋 Show as table] [📝 Summary] [⬇️ CSV] [👍] [👎]
```

- **Show as table**: Re-render the same results as a Block Kit table (≤6 columns) or code block (>6 columns)
- **Summary**: Re-render as natural language summary
- **CSV**: Upload results as a CSV file
- **Thumbs up/down**: Existing feedback mechanism

Note: "Show SQL" is no longer a button — SQL is always visible inline in the response (see Visible Reasoning below).

These override the bot's adaptive formatting choice without re-running the query — the results are already in `ResponseContext.queryResults`.

---

## 12. dbt Integration

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
    // Normalize catalog column keys to lowercase — BigQuery's catalog.json
    // reports column names in UPPERCASE while manifest.json uses lowercase.
    // Without this, every column lookup misses and falls through to 'UNKNOWN'.
    const catalogColumns = catalogNode?.columns
      ? Object.fromEntries(
          Object.entries(catalogNode.columns).map(([k, v]) => [k.toLowerCase(), v])
        )
      : {};
    const columns = Object.values(node.columns).map(col => ({
      name: col.name,
      description: col.description || '',
      dataType: catalogColumns[col.name.toLowerCase()]?.type || 'UNKNOWN',
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

### INFORMATION_SCHEMA Fallback

When a table is referenced in a query but has no dbt metadata (e.g., raw source tables, ad-hoc tables outside dbt), fall back to BigQuery's `INFORMATION_SCHEMA`:

```typescript
async function getSchemaFallback(
  projectId: string,
  datasetId: string,
  tableId: string
): Promise<TableContext> {
  const [columns] = await bigquery.query({
    query: `
      SELECT column_name, data_type, is_nullable, description
      FROM \`${projectId}.${datasetId}.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS\`
      WHERE table_name = @tableId
    `,
    params: { tableId },
  });

  return {
    name: `${datasetId}.${tableId}`,
    schema: datasetId,
    description: '', // No business description available
    materialization: 'unknown',
    columns: columns.map(c => ({
      name: c.column_name,
      description: c.description || '',
      dataType: c.data_type,
      meta: {},
    })),
    sampleDDL: generateDDLFromColumns(columns),
    dependsOn: [],
    tags: ['no-dbt-metadata'],
  };
}
```

**When the fallback triggers**: During schema retrieval, if a table appears in the user question but has no matching entry in the parsed dbt artifacts, the system queries `INFORMATION_SCHEMA` to build a minimal `TableContext`. These fallback entries lack business descriptions and lineage, so the LLM receives a lower-context schema — the prompt notes this explicitly so the model knows to be more cautious.

### Metadata Quality Awareness

Most real-world dbt projects have sparse metadata — many models lack descriptions, most columns have empty `description` fields, and tags are inconsistently applied. The design must account for this rather than assuming high-quality metadata.

**During ingestion**, compute a quality score per table:

```typescript
interface TableQuality {
  descriptionPresent: boolean;          // model has a non-empty description
  columnDescriptionCoverage: number;    // % of columns with descriptions (0-1)
  qualityTier: 'high' | 'medium' | 'low';
}

function assessQuality(table: TableContext): TableQuality {
  const described = table.columns.filter(c => c.description.trim().length > 0);
  const coverage = described.length / table.columns.length;
  return {
    descriptionPresent: table.description.trim().length > 0,
    columnDescriptionCoverage: coverage,
    qualityTier: coverage > 0.7 ? 'high' : coverage > 0.3 ? 'medium' : 'low',
  };
}
```

**In the prompt**, low-quality tables include a note so the LLM calibrates confidence appropriately:

```
Table: raw_events (⚠️ minimal documentation — 2/47 columns described)
```

Tables with `qualityTier: 'low'` should bias the Clarification Agent toward MEDIUM confidence (state assumptions explicitly) rather than HIGH. The Supervisor treats queries against poorly-documented tables as a review flag.

### Focus on Mart/Gold Layer

Only expose mart/gold layer models to the LLM (not staging or intermediate). These are the business-facing tables that users think about.

### Refresh Strategy

Refresh the metadata index on dbt CI completion via:
- GitHub Actions webhook after `dbt build` completes
- Periodic poll of artifacts from dbt Cloud API or GitHub repo

### Metadata Freshness Check

Teaching staleness has three detection levels (section 6), but the metadata itself can also go stale — if the webhook fails, dbt CI stops running, or someone redeploys without triggering a refresh. The bot would silently serve queries against outdated schema.

**Implementation**: Every metadata refresh writes a timestamp to Firestore (`config/metadata_state`):

```typescript
interface MetadataState {
  lastRefreshAt: Date;
  manifestVersion: string;   // hash of manifest.json for change detection
  tableCount: number;
  refreshSource: 'webhook' | 'poll' | 'manual';
}
```

At the top of every pipeline run, check the timestamp:

| Staleness | Action |
|-----------|--------|
| **<24h** | Normal operation |
| **24-48h** | Append warning to response: "Note: schema info was last updated {X} hours ago and may be outdated." |
| **>48h** | Alert data team via escalation channel; continue responding with visible warning |

The `/anna health` command (data team only) reports metadata age, table count, and last refresh source.

**Alerting**: Cloud Monitoring alert if `lastRefreshAt` exceeds 48 hours. This catches silent webhook failures before they cause bad answers.

### Run Status (MVP)

Answer questions like "when was `dim_customers` last built?", "did the last run succeed?", "which models failed?"

**Source**: `run_results.json` from each dbt run, ingested and stored in Firestore — not parsed from a single file at rest.

**Ingestion flow**:
1. dbt CI completes (GitHub Actions or dbt Cloud)
2. Post-run webhook sends `run_results.json` to Anna Lytics ingest endpoint
3. Anna Lytics parses and stores each model result as a Firestore document:
   ```
   collection: dbt_run_history
   doc: {runId}_{modelName}
   {
     model: string,
     status: 'success' | 'error' | 'skipped',
     executionTime: number,
     runId: string,
     runStartedAt: Date,
     errorMessage?: string,
   }
   ```
4. Historical runs are retained (Firestore TTL: 90 days) for trend questions

**What this enables**:
- "When was `dim_customers` last built?" → query most recent doc for that model
- "Did the last dbt run succeed?" → query all docs for most recent runId
- "Has `fct_orders` been failing?" → query last N runs for that model, check error rate
- "Which models are slowest?" → aggregate execution times

---

## 13. Query Validation Pipeline

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

**Layer 2 - AST Validation (advisory for parse, blocking for DML)**: Parse with `node-sql-parser` (BigQuery dialect). If the parser successfully parses the SQL, walk the AST to verify only `SELECT` statements exist and check referenced tables against an allowlist — DML/DDL detection is a **hard block**. However, if the parser *fails to parse* the SQL (returns a parse error), this is **advisory only** — log a warning and pass through to Layer 3 (dry run). `node-sql-parser`'s BigQuery dialect has known gaps (`QUALIFY`, `SAFE_DIVIDE`, nested `UNNEST`, some window functions), so a parse failure does not mean the SQL is invalid. Layer 3 (BigQuery dry run) is the authoritative validator for syntax and semantics.

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

**Layer 5 - Execution**: Run with `maximumBytesBilled` (hard cap), `jobTimeoutMs: 30000`, and `maxResults: 1000`. **When results hit the 1K row cap**, the bot reads the total row count from BigQuery's job metadata (`job.metadata.statistics.query.totalRows`) — this is free, requires no additional query, and is available on every completed job. No secondary `COUNT(*)` query needed (wrapping the original query as a subquery would scan all data a second time, doubling the cost). The response always tells the user when results are truncated: "Showing 1,000 of {totalRows} rows. [Download full CSV]" (see adaptive response format, section 14).

### Infrastructure-Level Safety

- **Read-only service account**: `bigquery.dataViewer` + `bigquery.jobUser` only
- **Dataset-level permissions**: Restrict to mart/gold datasets
- **Per-user daily quota**: Set via BigQuery project settings

### Channel-Based Access Control

Not every Slack channel should have access to every dataset. A configurable mapping restricts which datasets are queryable from which channels:

```typescript
interface ChannelAccessConfig {
  // Channel ID -> list of allowed BigQuery datasets
  channelDatasets: Record<string, string[]>;
  // Channels not in this map get default access
  defaultDatasets: string[];
  // DMs use this user-level mapping (optional, falls back to default)
  userDatasets?: Record<string, string[]>;
}

// Example config:
// #finance -> ["analytics_finance", "analytics_shared"]
// #marketing -> ["analytics_marketing", "analytics_shared"]
// #general -> ["analytics_shared"]  (default)
// DMs -> default datasets
```

**Enforcement**: Before SQL generation, the pipeline filters the schema context to only include tables from allowed datasets for the requesting channel. Tables in disallowed datasets are invisible — not blocked after the fact, but never offered to the LLM. The validation pipeline (Layer 2, AST check) also enforces the allowlist as a safety net.

**Config management**: YAML file in the repo, refreshed on deploy. Changes require a PR, not a bot command — access control is a governance decision.

---

## 14. Slack Integration

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
| `views:open` | Open `/anna teach` modal (Phase 1) |
| `views:publish` | Update modal views (Phase 1) |

### Event Subscriptions

| Event | Purpose |
|-------|---------|
| `app_mention` | Respond when @mentioned |
| `message.channels` | Listen for thread replies in public channels |
| `message.groups` | Listen for thread replies in private channels |
| `message.im` | Listen for DMs |

### Message Trigger Rules

The bot receives every message in channels it has joined, but it must NOT respond to all of them. A message filter at the top of the event handler determines whether to invoke the pipeline:

| Trigger | Action | Why |
|---------|--------|-----|
| **@mention in channel** | Respond | Explicit invocation |
| **DM (any message)** | Respond | Every DM is directed at the bot |
| **Thread reply where bot previously responded** | Respond | Refinement, meta-question, or follow-up |
| **Channel message without @mention** | Ignore | Side conversation, not directed at bot |
| **Thread reply where bot has NOT responded** | Ignore | Someone else's thread |

```typescript
function shouldRespond(event: MessageEvent): boolean {
  // Always respond in DMs
  if (event.channel_type === 'im') return true;

  // Always respond to @mentions (handled by app_mention event)
  if (event.type === 'app_mention') return true;

  // For channel messages: only respond in threads where bot has participated
  if (event.thread_ts) {
    return botHasRepliedInThread(event.channel, event.thread_ts);
  }

  // Bare channel message without @mention: ignore
  return false;
}
```

**`botHasRepliedInThread` implementation**: Do NOT call `conversations.replies()` — this would be a Slack API call on every thread message in every channel, quickly hitting Slack's rate limits (~50/min). Instead, check Firestore: the bot already writes `ResponseContext` documents keyed by `threadTs`. A single Firestore read (~5ms) replaces a Slack API call (~200ms + rate limit risk):

```typescript
async function botHasRepliedInThread(channel: string, threadTs: string): Promise<boolean> {
  const doc = await db.collection('response_context')
    .where('threadTs', '==', threadTs)
    .limit(1).select().get();  // select() fetches no fields — existence check only
  return !doc.empty;
}
```

This filter runs before any LLM calls — zero cost for ignored messages.

### Per-Thread Processing Lock

With 10-30 second pipeline runs, duplicate events are inevitable — double-clicks, rapid follow-ups, or Slack retrying a webhook. Without deduplication, the bot launches parallel pipelines for the same thread and posts interleaved results.

**Implementation**: Before starting a pipeline, attempt to create a Firestore document (`processing_threads/{threadTs}`) with a 300-second TTL (matching the Cloud Run timeout). If the document already exists and hasn't expired, the pipeline is already running — respond with "I'm still working on your previous question" and exit.

```typescript
async function acquireThreadLock(threadTs: string): Promise<boolean> {
  const ref = db.collection('processing_threads').doc(threadTs);
  try {
    await ref.create({
      startedAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 300_000), // 300s = Cloud Run timeout
    });
    return true; // lock acquired
  } catch (e) {
    if (e.code === 6) {
      // ALREADY_EXISTS — check if expired (Firestore TTL is eventually consistent)
      const doc = await ref.get();
      if (doc.exists && doc.data()!.expiresAt.toDate() < new Date()) {
        await ref.delete();
        return acquireThreadLock(threadTs); // retry after cleaning up
      }
      return false; // pipeline genuinely in progress
    }
    throw e;
  }
}
```

The lock is eagerly deleted when the pipeline completes (success or failure). The 300-second TTL matches the Cloud Run timeout — the worst case for a pipeline that hits escalation, supervisor retries, and execution. Firestore TTL is used only as a background cleanup mechanism for crashed pipelines, not as a correctness guarantee (same `expiresAt` check pattern as clarification state, section 8).

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
| Small table (<20 rows, ≤6 columns) | Block Kit section blocks formatted as table |
| Wide table (>6 columns) | CSV file upload or monospaced code block (Block Kit has no real table component — section blocks become unreadable beyond 6 columns, especially on mobile) |
| Large result (>20 rows) | Natural language summary + CSV file upload |
| **Zero rows** | "Your query ran successfully but returned no results." + deterministic filter summary extracted from the structured output's assumptions and SQL (e.g., "Filters applied: order_status = 'completed', order_date between 2026-01-01 and 2026-01-31") + offer to broaden: "Want me to try without the date filter?" No LLM speculation about *why* — the bot doesn't have access to the data distribution and a wrong guess ("maybe it's a weekend") is worse than honest transparency about what filters were applied. |
| **Truncated result (hit 1K row cap)** | Show first 1,000 rows + explicit notice: "Showing 1,000 of approximately {n} rows. [Download full CSV]" (see section 13, Layer 5) |

### Block Kit Constraints

- Max 50 blocks per message
- ~13K character aggregate limit across all blocks (undocumented but enforced)
- Use `slack-block-builder` npm package for pagination and rich formatting

### Handling the 3-Second Timeout

**Primary entry points**: @mention is the main trigger in channels. `/anna` is a convenience alias. DMs respond to all messages. Both entry points funnel into the same pipeline.

```typescript
// Slash command entry point (/anna <question>)
// Note: slash command ack() is ephemeral (only invoker sees it)
app.command('/anna', async ({ command, ack, client }) => {
  await ack(); // ephemeral ack — user sees nothing

  // Post a visible status message in the channel (creates a thread root)
  const statusMsg = await client.chat.postMessage({
    channel: command.channel_id,
    text: 'Understanding your question...',
  });

  // All subsequent messages (including final response) reply in this thread
  const threadTs = statusMsg.ts!;

  try {
    await runPipeline(command.text, command.channel_id, threadTs, client);
  } catch (error) {
    await client.chat.update({
      channel: command.channel_id,
      ts: threadTs,
      text: friendlyErrorMessage(error, traceId),
    });
  }
});

// @mention entry point (channels) + DM entry point
// Both use the message trigger rules (see above) to filter
app.event('app_mention', async ({ event, client }) => {
  // Use existing thread if mention is inside one, otherwise start a new thread
  const threadTs = event.thread_ts || event.ts;

  const statusMsg = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: 'Understanding your question...',
  });
  await runPipeline(event.text, event.channel, statusMsg.ts!, client);
});
```

### Error Handling

Pipeline errors must be mapped to user-friendly messages. Business users should never see raw technical errors like "RESOURCE_EXHAUSTED: Quota exceeded for aiplatform.googleapis.com."

```typescript
function friendlyErrorMessage(error: Error, traceId: string): string {
  // BigQuery errors
  if (error.message.includes('NOT_FOUND'))
    return "I couldn't find one of the tables I need. The data model may have changed recently.";
  if (error.message.includes('ACCESS_DENIED') || error.message.includes('FORBIDDEN'))
    return "I don't have access to query this data from this channel.";
  if (error.message.includes('DEADLINE_EXCEEDED') || error.message.includes('timeout'))
    return "This query took too long. Try asking for a smaller time range or fewer dimensions.";

  // Gemini errors
  if (error.message.includes('RESOURCE_EXHAUSTED'))
    return "I'm experiencing high demand — please try again in a moment.";
  if (error.message.includes('SAFETY'))
    return "I wasn't able to process that question. Try rephrasing it.";

  // Default — always include traceId so the data team can investigate
  return `Something went wrong. I've logged the details for the data team. (trace: ${traceId})`;
}
```

The `traceId` is always logged regardless of error type. The friendly message is what the user sees; the full error is in Cloud Logging under the trace ID.

### Progressive Status Updates

The Phase 1 pipeline takes 10-30 seconds (clarification + schema + generation + validation + supervision + execution + formatting). A static "Thinking..." message for that duration feels broken. Instead, the bot updates a single message in-place via `chat.update()` after each pipeline stage completes:

Only update after stages that take >1 second — skip fast stages (static analysis, dry run, cost gate) to stay well within Slack's `chat.update` rate limit (~50/min per workspace). With `concurrency=20`, that's 3-4 updates x 20 = 60-80 calls per batch, manageable with minor queuing.

```
Stage 1 (Clarification):    "Understanding your question..."     ← update
Stage 2 (Schema):            (skip — <500ms)
Stage 3 (Primary Agent):    "Generating SQL..."                  ← update
Stage 4 (Validation):        (skip — <1s total for L1-L4)
Stage 5 (Supervisor):       "Reviewing answer..."                ← update
Stage 6 (Execution):         (skip — folded into final update)
Stage 7 (Format):           Final answer replaces the message    ← update
```

**Implementation**: `chat.postMessage()` returns a `ts` (message timestamp) that acts as the message ID. The pipeline calls `chat.update()` only 3-4 times total. The final stage replaces the status text with the full response (blocks, buttons, reasoning toggle). One message, updated in-place — no dead "Thinking..." artifacts, no duplicate posts.

```typescript
const statusMsg = await client.chat.postMessage({
  channel, thread_ts,
  text: 'Understanding your question...',
});

const updateStatus = async (text: string) => {
  await client.chat.update({
    channel, ts: statusMsg.ts!, text,
  });
};

// Only update after slow stages (>1s)
// ... clarification agent ...
await updateStatus('Generating SQL...');
// ... schema retrieval + primary agent ...
await updateStatus('Reviewing answer...');
// ... validation + supervisor ...

// Final response replaces the message entirely
await client.chat.update({
  channel, ts: statusMsg.ts!,
  text: results.formatted,
  blocks: results.blocks,
});
```

**Why not streaming**: The pipeline architecture prevents meaningful streaming — nothing can stream to the user until the supervisor approves. Progressive stage updates give the user a sense of movement (every 2-5 seconds) without requiring streaming support.

### Per-User Rate Limiting

Each pipeline run involves 1-5+ LLM calls and a BigQuery execution. Without rate limiting, a single user (or a bot loop) could burn through budget in minutes. Rate limiting is applied at the Slack user level, not the channel level.

**Implementation**: Firestore-backed sliding window counter (no Redis needed):

```typescript
interface RateLimitEntry {
  userId: string;
  windowStart: Date;     // start of current 1-hour window
  queryCount: number;    // queries in this window
}

const RATE_LIMIT = {
  queriesPerHour: 30,      // per user
  queriesPerMinute: 5,     // burst protection
  cooldownMessage: "You've hit the query limit (30/hour). This resets in {minutes} minutes. For urgent queries, ask in the escalation channel directly.",
};
```

**Why Firestore, not in-memory**: Cloud Run can have multiple instances. An in-memory counter per instance would let a user bypass limits by hitting different instances. Firestore provides a single source of truth. The read-then-write is acceptable because rate limiting doesn't need sub-millisecond precision — a few extra queries slipping through on a race condition is fine.

**UX**: When rate-limited, the bot `ack()`s normally but responds with a friendly message instead of processing the query. The user sees the remaining cooldown time.

---

## 15. Feedback and Learning

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

### In-Conversation Learning (MVP)

Feedback must have teeth in MVP, not just log to Firestore. When a user gives thumbs-down and then rephrases or asks a follow-up in the same thread, the bot incorporates the negative signal:

```
User: "Show me revenue by region"
Bot: [returns result]
User: 👎
User: "No, I meant subscription revenue, not order revenue"
```

On the rephrased follow-up, the pipeline receives:
1. The original `ResponseContext` (what SQL was generated, what tables were used)
2. The negative feedback signal
3. The follow-up message explaining what was wrong

This is injected into the Primary Agent prompt as a **negative example**:

```
PREVIOUS ATTEMPT (rejected by user):
SQL: SELECT ... FROM fct_orders ...
User feedback: "No, I meant subscription revenue, not order revenue"
Do NOT repeat this approach. Adjust based on the user's correction.
```

This doesn't require an analyst review queue. It works within a single conversation. And critically, it makes the thumbs-down button feel like it *does something* — the very next response is visibly informed by the feedback.

### Feedback-to-Teachings Promotion

High-quality corrected SQL from the feedback loop can be promoted into the Knowledge Base (section 6). This complements the auto-teaching from escalations (section 10) — escalations capture *pre-answer* domain knowledge, while feedback promotion captures *post-answer* corrections:

```
Feedback loop:
  1. User gives thumbs-down
  2. Analyst corrects SQL in review queue (Tier 3)
  3. Corrected (question, SQL) pair stored in Firestore
         |
         v
Promotion candidates:
  - Corrected SQL that receives subsequent thumbs-up when reused
  - Patterns that appear 3+ times across different users
  - Analyst explicitly marks a correction as "promote to teaching"
         |
         v
Auto-generate teaching PR:
  - Bot creates a YAML teaching entry from the corrected pair
  - Opens a PR in the teachings repo via GitHub API
  - Data team reviews and merges
  - CI syncs to File Search store
```

This closes the loop: user feedback improves accuracy immediately (as few-shot examples in Firestore) and, once promoted, becomes durable governance via the Knowledge Base.

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

## 16. Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Runtime | Cloud Run (Node.js 20, distroless, 1Gi/2CPU) | Serverless, GCP-native, IAM integration |
| Bot framework | Bolt.js (TypeScript, HTTP mode) | Official Slack SDK, first-class TS support |
| LLM SDK | Google GenAI SDK (`@google/genai`) | Official Gemini API client, native Zod structured output, File Search built in |
| LLM models | Gemini 3.0 Pro (generation, supervision) + Flash (classification, summarization) | GCP-native, strong text-to-SQL, cost-effective |
| Teaching retrieval | Gemini File Search (managed RAG) | Zero-infra RAG: auto-chunking, embedding, retrieval, citations. Free at query time. |
| Database client | @google-cloud/bigquery | Official Node.js client |
| SQL validation | node-sql-parser | AST-level DML/DDL blocking (advisory on parse failure — BigQuery dry run is authority) |
| State store | Firestore | Conversation state, feedback, response context, escalation state, dbt run history, sample rows |
| Observability | `pino` (structured JSON) → Cloud Logging + Cloud Monitoring | Per-request trace IDs, stage-level metrics, dashboards + alerting |
| dbt metadata | Custom parser (manifest.json + catalog.json) | Direct parsing, no external deps |
| Knowledge base | YAML files in Git repo → synced to File Search store | Version-controlled, PR-reviewed teachings; File Search handles retrieval |
| Access control | YAML channel-dataset config in repo | Channel-based dataset restrictions, PR-managed |
| Infra-as-code | Terraform | Cloud Run + IAM + Firestore provisioning |
| CI/CD | GitHub Actions | Build, test, deploy, sync teachings to File Search, refresh sample rows |

---

## 17. Extensibility Path

| Phase | Addition | Approach |
|-------|----------|----------|
| Post-MVP | Trigger dbt runs from Slack | GitHub Actions API to trigger dbt workflow |
| Post-MVP | Chart/visualization | Server-side chart generation (chart.js + canvas) uploaded as Slack images |
| Post-MVP | Full dbt graph browsing | Tool-based dbt metadata search for meta-questions beyond the retrieved context (e.g., exploring unrelated models, deep multi-hop lineage traversal, reading compiled model SQL). MVP covers 80% of meta-questions via persisted `retrievedSchema`; this covers the remaining 20%. |
| Future | Dataproc/PySpark | Plugin architecture: add a "pipeline provider" interface alongside dbt |
| Future | Databricks | Same plugin interface, Databricks REST API for job status and SQL warehouse queries |
| Future | Multi-tenant | Tenant isolation via separate BigQuery service accounts + Firestore namespacing |

The LLM SDK (Google GenAI) and the pipeline metadata interface should be designed as pluggable from day one, even though only BigQuery + dbt are implemented in the MVP.

---

## 18. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| LLM generates incorrect SQL | Wrong data shown to business users | Supervisor Agent review, teachings compliance, confidence levels, feedback loop |
| Runaway BigQuery costs | Unexpected charges | 5-layer validation, cost gate, maximumBytesBilled, per-user quotas |
| Slack 3-second timeout exceeded | Bot appears broken | min-instances=1, CPU boost, immediate ack pattern |
| Schema drift (dbt changes) | Stale metadata leads to bad SQL | Auto-refresh on dbt CI completion, fallback to INFORMATION_SCHEMA |
| Gemini API outage | Bot cannot respond | Graceful degradation message; consider adding fallback provider via GenAI SDK |
| PII exposure in query results | Compliance violation | Dataset-level permissions, column-level masking, no result data in logs |
| Stale teachings | Governance rules reference dropped models | Staleness detection: compare teaching model_refs against manifest on CI |
| Supervisor adds latency | Slower response times (extra 1-3 LLM calls) | Supervisor uses smaller context than primary; happy path adds ~2-3s |
| Over-clarification | Bot asks too many questions, frustrates users | Smart threshold: only clarify on genuinely low confidence; thread context awareness |
| LLM cost escalation (multi-agent) | 3-7 LLM calls per query vs 1 | Flash for classification ($0.50/M); Pro supervisor has smaller context than Primary; cost monitoring |
| Teachings drift from actual practice | Sanctioned SQL becomes outdated | PR review process, staleness flags, periodic audit by data team |
| Escalation overload | Data team drowning in bot questions, negating self-serve goal | Track escalation rate (target <10% after 3 months); repeat escalations auto-flag missing teachings |
| Escalation non-response | Human never replies, user left hanging | Configurable timeout (default 4h); reminder pings; fallback to best-effort with caveat after timeout |
| Escalation rate stays flat | Bot is not learning from human responses | Alert on flat/rising escalation rate; auto-teaching conversion as primary mitigation |
| ResponseContext storage growth | Firestore costs increase with every query | TTL on ResponseContext (30 days); archive older contexts; only persist full results for 7 days |
| Diagnostic queries cause confusion | User asks "why?" and gets a second, different number | Clearly label diagnostic results as investigative, not authoritative; show alongside original |
| File Search store sync failure | Teachings out of date, retrieval returns stale content | CI job validates sync success; alert on failure; teachings in Git remain source of truth |
| Channel access misconfiguration | Users blocked from data they should access | Default datasets as fallback; admin audit log; easy YAML config in repo |
| Pipeline latency (10-30s) | User thinks bot is broken | Progressive status updates via `chat.update()` after each stage; user sees movement every 2-5s |
| Bot responds to unrelated messages | Wasted LLM calls, annoying unsolicited responses | Message trigger rules: only respond to @mentions, DMs, and thread replies where bot has participated |
| dbt metadata goes stale silently | Queries generated against outdated schema | `lastMetadataRefresh` timestamp in Firestore; warnings at 24h, alerts at 48h; `/anna health` command |
| Sparse dbt metadata (empty descriptions) | LLM generates low-quality SQL from undocumented tables | Per-table quality score injected into prompt; low-quality tables flagged to LLM and Clarification Agent |
| Concurrent duplicate requests | Interleaved pipeline results in same thread | Per-thread processing lock in Firestore (60s TTL); second request gets "still working" message |
| User posts during pending escalation | New pipeline launches on parked thread | Escalation state check before pipeline; user told "still waiting for data team" |
| node-sql-parser false negatives | Valid BigQuery SQL rejected by Layer 2 | Layer 2 is advisory on parse failure, blocking only for DML/DDL; Layer 3 (dry run) is authority |
| Multiple confidence signals confuse escalation logic | Clarification says HIGH, Supervisor says LOW — which drives decisions? | Confidence hierarchy: user-facing = min(supervisor, primary). Clarification confidence is routing-only, never surfaced. |
| MEDIUM assumptions mislead users | User sees wrong answer before realizing wrong assumptions | Assumptions shown first (bold, above results) + one-click refine button for fast recovery |
| Raw error messages shown to business users | User sees "RESOURCE_EXHAUSTED: Quota exceeded" | Error category mapping to friendly messages; traceId always included for debugging |
| Slack chat.update rate limits | Progressive status updates fail silently at high concurrency | Update only after slow stages (3-4 calls per pipeline, not 7); stays within 50/min limit |
