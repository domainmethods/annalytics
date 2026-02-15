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
6. **Knowledge Base (Teachings)**: Analyst-curated SQL examples and reasoning instructions injected via RAG to guide the agent on sanctioned query patterns — acts as pseudo-governance
7. **Supervisor Agent**: A second LLM pass that reviews the generated SQL, the logic/explanation, and the answer before it reaches the user — with retry loop on rejection
8. **Clarification Agent**: Smart intake that detects ambiguous questions and asks targeted follow-up questions before generating SQL, ensuring the bot answers the user's actual intent

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
User: "Show me revenue"
                    |
                    v
    +--- 1. Receive + Ack ------------------+
    |   - Bolt.js receives Slack event       |
    |   - ack() immediately                  |
    |   - Post "Thinking..." message         |
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
    +--- 3. Schema + Knowledge Retrieval ----+
    |   - Embed the (clarified) question     |
    |   - Retrieve top 5-15 relevant tables  |
    |     from dbt metadata index            |
    |   - Retrieve top 3-5 relevant          |
    |     Teachings from knowledge base      |
    |     (sanctioned SQL, reasoning notes,  |
    |     business definitions)              |
    +----------------+-----------------------+
                     v
    +--- 4. SQL Generation (Primary Agent) --+
    |   - System prompt with:                |
    |     - BigQuery SQL rules               |
    |     - Retrieved table DDLs             |
    |     - Column descriptions from dbt     |
    |     - Sample rows                      |
    |     - Teachings (sanctioned examples)  |
    |     - Dynamic few-shot examples        |
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
    |   - EXHAUSTED: proceed with visible    |
    |     low-confidence caveat              |
    +----------------+-----------------------+
                     v
    +--- 7. Execute + Respond ---------------+
    |   - Run query (30s timeout, 1K rows)   |
    |   - Adaptive formatting                |
    |   - Include supervisor assessment      |
    |     (if low confidence)                |
    |   - Include thumbs-up/down buttons     |
    |   - Log to feedback store              |
    +----------------------------------------+
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
| SQL generation (Primary Agent) | Claude Sonnet / GPT-4o | Best accuracy on text-to-SQL benchmarks |
| Supervisor Agent | Claude Sonnet / GPT-4o | Needs strong reasoning to catch errors in generated SQL |
| Clarification Agent | Claude Haiku / GPT-4o-mini | Classification task: is the question clear enough? Fast + cheap |
| Question routing | Claude Haiku / GPT-4o-mini | "Is this a data question or a dbt status question?" |
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

### Authoring via Slack (Convenience Layer)

`/anna teach` opens a Slack modal with fields for:
- Business question (natural language)
- Sanctioned SQL (optional)
- Reasoning / instructions
- Tags

On submission, the bot auto-creates a PR in the repo via GitHub API. Once merged, CI rebuilds the RAG index.

### RAG Retrieval at Query Time

1. Embed each teaching's `question_patterns` + `reasoning` text
2. At query time, embed the user's question
3. Retrieve top 3-5 most semantically similar teachings
4. Inject into the prompt under a `TEACHINGS` section:

```
TEACHINGS (sanctioned patterns for similar questions):

Teaching: "Monthly Revenue"
Sanctioned SQL:
  SELECT DATE_TRUNC(order_date, MONTH) AS month, ...
Reasoning: Revenue always uses fct_orders with order_status = 'completed'...

Teaching: "Churn Definition"
Reasoning: A customer is "churned" if no completed orders in 90 days...
```

### Staleness Protection

- Each teaching references specific dbt models (`models_referenced`)
- When a referenced model is dropped or renamed in dbt, flag the teaching as stale
- Stale teachings are excluded from RAG retrieval until an analyst updates them
- CI job compares teaching model references against current manifest.json

### Governance Effect

Teachings act as soft governance: the agent is strongly guided toward sanctioned patterns but can still generate novel SQL for questions without teachings. The Supervisor Agent (section 7) checks whether the generated SQL aligns with relevant teachings when they exist.

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

RELEVANT TEACHINGS:
{retrieved_teachings}

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

### Cost Considerations

The Supervisor adds 1-3 extra LLM calls per query. To manage costs:
- Use the same model tier as the Primary Agent (Sonnet/GPT-4o) — the supervisor needs strong reasoning
- The supervisor prompt is smaller than the primary prompt (no schema DDL, just the SQL + explanation to review)
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
| **MEDIUM** | Answer with explicitly stated assumptions | "Show me revenue" -> "Showing monthly revenue for all regions, last 12 months (assuming completed orders only)" |
| **LOW** | Ask 1-2 targeted clarifying questions before proceeding | "How are we doing?" -> "Could you clarify: are you asking about revenue, customer growth, or something else?" |

### Classification Prompt

```
You are a data analyst intake specialist. Evaluate whether the
following question has enough specificity to generate an accurate
SQL query against our data warehouse.

AVAILABLE CONTEXT:
- Business terms we know: {list_of_teaching_tags_and_definitions}
- Common metrics: {list_of_known_metrics}

USER QUESTION: {question}
THREAD CONTEXT: {previous_messages_in_thread}

Classify and respond:
{
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

The bot uses Block Kit buttons for common choices (fast click) with a text fallback for custom answers. Once the user responds, the clarified question flows into Schema Retrieval and SQL Generation.

### Thread Context Awareness

The Clarification Agent considers the full thread context. If the user has already been discussing customer churn in the thread, a follow-up like "now show me by region" doesn't need clarification — the agent infers the topic from thread history.

```typescript
const thread = await client.conversations.replies({
  channel, ts: thread_ts, oldest: thread_ts,
});

const threadContext = thread.messages!.map(m => ({
  role: m.bot_id ? 'assistant' : 'user',
  content: m.text || '',
}));

// Include thread context in clarification prompt
```

### When NOT to Clarify

- User explicitly says "just guess" or "best guess is fine"
- The question matches a Teaching exactly (sanctioned query exists)
- Follow-up in a thread where the topic is already established
- Simple, unambiguous questions ("how many X yesterday?")

---

## 9. Agent Pipeline Summary

The three agents form a pipeline with distinct roles:

```
User Question
    |
    v
[Clarification Agent] -- "Do I understand the question?"
    |                     Uses: Haiku/mini (cheap, fast classification)
    |                     Output: clarified question + assumptions
    v
[Knowledge Base RAG] --- "What do we already know about this?"
    |                     Retrieves: teachings, sanctioned SQL, definitions
    v
[Primary Agent] -------- "Generate the SQL"
    |                     Uses: Sonnet/GPT-4o (best accuracy)
    |                     Input: schema + teachings + clarified question
    |                     Output: SQL + explanation + reasoning chain
    v
[Validation Pipeline] -- "Is the SQL safe to run?"
    |                     5-layer technical validation
    v
[Supervisor Agent] ----- "Is the answer correct and compliant?"
    |                     Uses: Sonnet/GPT-4o (strong reasoning)
    |                     Checks: correctness, teaching compliance, logic
    |                     Can: retry Primary Agent up to 2x
    v
[Execute + Respond] ---- "Deliver the answer"
```

### Cost per Query (Estimated)

| Scenario | LLM Calls | Approx Cost |
|----------|-----------|-------------|
| Happy path (high confidence, supervisor passes) | 3 (clarify + generate + supervise) | ~$0.02-0.05 |
| Clarification needed | 4+ (clarify + wait + generate + supervise) | ~$0.03-0.06 |
| Supervisor retry (1 round) | 5 (clarify + generate + supervise + regenerate + supervise) | ~$0.05-0.10 |
| Worst case (2 retries) | 7 calls | ~$0.08-0.15 |

Note: Clarification Agent uses cheap models (Haiku/mini at ~$0.001/call). The expensive calls are Primary + Supervisor (Sonnet/GPT-4o).

---

## 10. dbt Integration

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

## 11. Query Validation Pipeline

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

## 12. Slack Integration

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

## 13. Feedback and Learning

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

## 14. Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Runtime | Cloud Run (Node.js 20, distroless) | Serverless, GCP-native, IAM integration |
| Bot framework | Bolt.js (TypeScript, HTTP mode) | Official Slack SDK, first-class TS support |
| LLM abstraction | Vercel AI SDK v5 | Provider-agnostic, Zod structured output, streaming |
| Database client | @google-cloud/bigquery | Official Node.js client |
| SQL validation | node-sql-parser | AST-level SELECT-only enforcement |
| State/feedback | Firestore | Serverless, no connection pool, thread context |
| Schema + teachings index | In-memory (MVP) -> vector DB later | RAG over dbt metadata and teachings; <30 tables: simple; >30: vector store |
| dbt metadata | Custom parser (manifest.json + catalog.json) | Direct parsing, no external deps |
| Knowledge base | YAML files in Git repo | Version-controlled, PR-reviewed teachings |
| Infra-as-code | Terraform | Cloud Run + IAM + Firestore provisioning |
| CI/CD | GitHub Actions | Build, test, deploy, rebuild RAG index |

---

## 15. Extensibility Path

| Phase | Addition | Approach |
|-------|----------|----------|
| Post-MVP | Trigger dbt runs from Slack | GitHub Actions API to trigger dbt workflow |
| Post-MVP | Chart/visualization | Server-side chart generation (chart.js + canvas) uploaded as Slack images |
| Future | Dataproc/PySpark | Plugin architecture: add a "pipeline provider" interface alongside dbt |
| Future | Databricks | Same plugin interface, Databricks REST API for job status and SQL warehouse queries |
| Future | Multi-tenant | Tenant isolation via separate BigQuery service accounts + Firestore namespacing |

The LLM abstraction (Vercel AI SDK) and the pipeline metadata interface should be designed as pluggable from day one, even though only BigQuery + dbt are implemented in the MVP.

---

## 16. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| LLM generates incorrect SQL | Wrong data shown to business users | Supervisor Agent review, teachings compliance, confidence levels, feedback loop |
| Runaway BigQuery costs | Unexpected charges | 5-layer validation, cost gate, maximumBytesBilled, per-user quotas |
| Slack 3-second timeout exceeded | Bot appears broken | min-instances=1, CPU boost, immediate ack pattern |
| Schema drift (dbt changes) | Stale metadata leads to bad SQL | Auto-refresh on dbt CI completion, fallback to INFORMATION_SCHEMA |
| LLM API outage | Bot cannot respond | Graceful degradation message, multi-provider failover via AI SDK |
| PII exposure in query results | Compliance violation | Dataset-level permissions, column-level masking, no result data in logs |
| Stale teachings | Governance rules reference dropped models | Staleness detection: compare teaching model_refs against manifest on CI |
| Supervisor adds latency | Slower response times (extra 1-3 LLM calls) | Supervisor uses smaller context than primary; happy path adds ~2-3s |
| Over-clarification | Bot asks too many questions, frustrates users | Smart threshold: only clarify on genuinely low confidence; thread context awareness |
| LLM cost escalation (multi-agent) | 3-7 LLM calls per query vs 1 | Cheap models for classification; supervisor has smaller context; cost monitoring |
| Teachings drift from actual practice | Sanctioned SQL becomes outdated | PR review process, staleness flags, periodic audit by data team |
