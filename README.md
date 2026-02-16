# Anna Lytics

A Slack bot that answers business questions by translating natural language into BigQuery SQL. Uses dbt metadata as a semantic layer, Gemini 3.0 Pro for SQL generation, and RAG via Gemini File Search for domain-specific knowledge.

## Architecture

### Pipeline Stages

Users ask questions in Slack via `@Anna Lytics`, `/anna`, DMs, or thread replies. Each question flows through a 7-stage pipeline (`src/pipeline.ts`):

1. **Clarification** — Classifies question confidence as high/medium/low. Low-confidence questions suspend the pipeline and post clarifying questions. Medium/high proceed with assumptions noted.
2. **Retrieval** — Loads two context sources for the SQL generator: cached sample rows (concrete data examples per table) and teaching summaries from the knowledge base (business definitions, metric formulas, sanctioned SQL patterns).
3. **SQL Generation + Supervisor Loop** — The primary agent generates BigQuery SQL using dbt schema, sample rows, and RAG-retrieved teachings as context. A supervisor agent then reviews it; on rejection, the primary agent retries with the critique (up to 2 retries). If File Search is unavailable, the agent falls back to generation without RAG and caps confidence at `medium`.
4. **Validation (L1-L4)** — Four sequential validation layers:
   - **L1 Static Analysis** — Blocks DML/DDL, multi-statement queries, and SQL comments
   - **L2 AST Validation** — Parses SQL into an AST to verify it's a single SELECT
   - **L3 Dry Run** — BigQuery dry run for syntax errors and byte-scan estimation
   - **L4 Cost Gate** — Rejects queries exceeding the configured scan limit
   If validation fails, the pipeline retries SQL generation once with the error as a self-correction prompt.
5. **Execution** — Runs the validated query against BigQuery with timeout and row limits.
6. **Format + Respond** — Posts Slack blocks with the result (single value, table, or zero-row message), the SQL, an explanation, and feedback buttons.
7. **Persist** — Saves the full response context (SQL, explanation, confidence, reasoning chain, trace ID) to Firestore.

All queries are read-only. The bot cannot modify data.

### dbt as a Semantic Layer

The bot uses dbt's `manifest.json` and `catalog.json` as its understanding of the data warehouse. At startup, `src/dbt/parser.ts` merges both artifacts into an in-memory array of `TableContext` objects (one per dbt model) containing:

- **Table and column names** with descriptions from dbt YAML schema files
- **Column data types** from `catalog.json` (e.g. `STRING`, `INT64`, `TIMESTAMP`)
- **Materialization type** (`table`, `view`, `incremental`) and DAG dependencies
- **Synthetic DDL** (`CREATE TABLE ...`) with column descriptions as inline comments, injected into the SQL generator's system prompt

Tables with less than 30% of columns described are flagged in the prompt so the LLM is cautious with poorly documented schema (`src/dbt/quality.ts`).

The bot can only query tables in the dbt project. Schema changes in BigQuery have no effect until dbt artifacts are regenerated and redeployed.

### Teachings (RAG Knowledge Base)

Domain-specific knowledge (business definitions, metric formulas, sanctioned SQL patterns) is authored as YAML files in `teachings/`. The sync script converts each teaching to markdown and uploads it to a Gemini File Search store. During SQL generation, Gemini automatically retrieves relevant teachings via RAG, grounding its output in domain knowledge.

Teaching summaries are also written to Firestore and cached in memory (refreshed every 5 minutes) for use by the clarification agent.

```bash
npx tsx scripts/sync-teachings.ts   # manual sync
```

This also runs automatically via the `sync-teachings` GitHub Actions workflow.

### Confidence Reconciliation

Final confidence = `min(primary agent, supervisor)` (`src/agents/confidence.ts`). Disagreement always produces a more conservative result.

### Feedback Loop

Responses include thumbs up/down buttons. Negative feedback is recorded in Firestore. When the user replies in a thread after negative feedback, the bot loads the rejected SQL as a negative example and re-runs the pipeline to generate a corrected query. The "Wrong assumptions?" button prompts the user to provide corrections in-thread, triggering the same re-run flow.

### Clarification Flow

When the clarification agent classifies a question as low-confidence:

1. Posts clarifying questions with interactive buttons
2. Saves clarification state to Firestore
3. Suspends the pipeline (no SQL generated)

When the user replies, `checkClarificationReply` detects the pending state and resumes the pipeline with the clarified question.

## Prerequisites

- **Node.js 20+**
- **GCP project** with BigQuery, Firestore, Secret Manager, Cloud Run, and Artifact Registry APIs enabled
- **Slack app** with Bot Token and Signing Secret ([setup guide](https://api.slack.com/start))
- **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey)
- **dbt artifacts** (`manifest.json` and `catalog.json`) from your dbt project

### Slack App Configuration

The Slack app needs these features enabled:

**Event Subscriptions** (request URL: `https://<your-cloud-run-url>/slack/events`):
- `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`

**Slash Commands:** `/anna` pointing to `https://<your-cloud-run-url>/slack/events`

**Bot Token Scopes:**
`app_mentions:read`, `channels:history`, `chat:write`, `commands`, `groups:history`, `im:history`, `mpim:history`

## Local Development

```bash
npm install
cp .env.example .env   # fill in values
```

Generate dbt artifacts and place them in `dbt/`:

```bash
cd /path/to/your-dbt-project
dbt compile && dbt docs generate
cp target/manifest.json target/catalog.json /path/to/annalytics/dbt/
```

Run locally:

```bash
npm run dev
```

Run tests and linting:

```bash
npm test                    # all tests
npm run typecheck           # type checking only
npx vitest run path/to/test # single test file
npm run lint                # ESLint
npm run lint:fix            # ESLint with auto-fix
```

### Git Hooks

Husky is configured with:

- **pre-commit** — Runs `lint-staged` (ESLint auto-fix on staged `.ts` files) and `tsc --noEmit`
- **pre-push** — Runs the full test suite

## Project Structure

```
src/
  app.ts                  # Bolt.js entry point, event handlers, startup
  pipeline.ts             # 7-stage orchestrator
  config.ts               # Environment variable loading
  types.ts                # Shared types (SqlGenerationResult, QueryResult, etc.)
  agents/                 # LLM agents
    clarificationAgent.ts # Question classification (high/medium/low)
    sqlGenerator.ts       # Primary SQL generation agent
    supervisorAgent.ts    # SQL review agent
    supervisorLoop.ts     # Generate -> review -> retry loop
    confidence.ts         # Confidence reconciliation logic
    followUpClassifier.ts # Thread follow-up detection
  validation/             # 4-layer SQL validation
    pipeline.ts           # L1->L2->L3->L4 orchestrator
    staticAnalysis.ts     # L1: Regex keyword blocking
    astValidation.ts      # L2: SQL AST parse check
    dryRun.ts             # L3: BigQuery dry run
    costGate.ts           # L4: Byte scan limit
  execution/              # Query execution
    runner.ts             # BigQuery query runner
    formatter.ts          # Response format chooser
  dbt/                    # dbt metadata
    parser.ts             # manifest.json + catalog.json parser
    quality.ts            # Table documentation quality assessment
    sampleRowCache.ts     # Cached sample rows for prompt context
    sampleRows.ts         # BigQuery sample row fetcher
  teachings/              # Knowledge base system
    parser.ts             # YAML teaching file parser
    summaryMap.ts         # In-memory summary cache + Firestore sync
    fileSearchSync.ts     # Gemini File Search upload
    markdownConverter.ts  # Teaching -> markdown for File Search
  slack/                  # Slack message builders
    blocks.ts             # Response blocks (table, single value, etc.)
    clarificationBlocks.ts# Clarification question blocks
    threadContext.ts       # Thread history summarizer
  state/                  # Firestore-backed state
    firestore.ts          # Firestore client singleton
    responseContext.ts     # Response persistence + feedback recording
    clarificationState.ts # Pending clarification state
    threadLock.ts         # Per-thread concurrency lock
    rateLimiter.ts        # Per-user rate limiting
  handlers/               # Slack event handlers
    commands.ts           # /anna slash command
    mentions.ts           # @Anna Lytics mentions
    messages.ts           # DMs and thread replies
scripts/
  sync-teachings.ts       # Teaching YAML -> File Search + Firestore sync
teachings/                # Teaching YAML files (domain knowledge)
infra/                    # Terraform (Cloud Run, Firestore, etc.)
```

## Infrastructure Setup

Infrastructure is managed with Terraform in `infra/`.

```bash
cd infra
terraform init
terraform apply \
  -var="project_id=your-gcp-project" \
  -var="slack_bot_token=xoxb-..." \
  -var="slack_signing_secret=..." \
  -var="gemini_api_key=..."
```

This provisions:
- Cloud Run service (2 CPU, 1Gi memory, min 1 / max 10 instances)
- Service account with read-only BigQuery + Firestore access
- Secret Manager secrets for Slack and Gemini credentials
- Artifact Registry for Docker images
- Firestore database

## Deployment

### Automatic (CI/CD)

Pushing to `main` triggers the GitHub Actions workflow (`.github/workflows/deploy.yml`):

1. Runs type checking and tests
2. Builds the Docker image
3. Pushes to Artifact Registry
4. Deploys to Cloud Run

**Required GitHub Secrets:**

| Secret | Description |
|--------|-------------|
| `GCP_PROJECT_ID` | Your GCP project ID |
| `WIF_PROVIDER` | Workload Identity Federation provider resource name |
| `WIF_SERVICE_ACCOUNT` | Service account email for WIF |

### Manual

```bash
# Build and push
export PROJECT_ID=your-project
export REGION=us-central1

docker build -t ${REGION}-docker.pkg.dev/${PROJECT_ID}/anna-lytics/anna-lytics:latest .
docker push ${REGION}-docker.pkg.dev/${PROJECT_ID}/anna-lytics/anna-lytics:latest

# Deploy
gcloud run deploy anna-lytics \
  --image ${REGION}-docker.pkg.dev/${PROJECT_ID}/anna-lytics/anna-lytics:latest \
  --region ${REGION}
```

## Updating dbt Metadata

The bot reads dbt metadata at startup from files baked into the container image. To update after schema changes:

1. Regenerate artifacts: `dbt compile && dbt docs generate`
2. Copy `manifest.json` and `catalog.json` to `dbt/`
3. Commit and push to `main` (triggers a new build + deploy)

The `/refresh-metadata` endpoint exists as a placeholder for future live-reload support.

## Configuration

All configuration is via environment variables. See `.env.example` for the full list.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | Yes | | Slack bot OAuth token |
| `SLACK_SIGNING_SECRET` | Yes | | Slack request signing secret |
| `GEMINI_API_KEY` | Yes | | Google AI API key |
| `GCP_PROJECT_ID` | Yes | | GCP project for BigQuery and Firestore |
| `DBT_MANIFEST_PATH` | No | `./dbt/manifest.json` | Path to dbt manifest |
| `DBT_CATALOG_PATH` | No | `./dbt/catalog.json` | Path to dbt catalog |
| `PORT` | No | `3000` | HTTP port |
| `COST_GATE_MAX_BYTES` | No | `10737418240` (10 GB) | Max bytes a query can scan |
| `QUERY_TIMEOUT_MS` | No | `30000` | Query execution timeout |
| `MAX_RESULT_ROWS` | No | `1000` | Max rows returned |
| `RATE_LIMIT_PER_HOUR` | No | `30` | Queries per user per hour |
| `LOG_LEVEL` | No | `info` | pino log level |
| `GEMINI_MODEL` | No | `gemini-3.0-pro` | Gemini model ID |
| `FILE_SEARCH_STORE_ID` | No | | Gemini File Search store for teachings |

## Health Check

```
GET /health -> 200 OK
```
