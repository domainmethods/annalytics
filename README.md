# Anna Lytics

A Slack bot that answers business questions by translating natural language into BigQuery SQL. Uses dbt metadata as a semantic layer and Gemini 3.0 Pro for SQL generation.

## Architecture

### Pipeline Stages

Users ask questions in Slack via `@Anna Lytics`, `/anna`, DMs, or thread replies. Each question flows through a 7-stage pipeline (`src/pipeline.ts`):

1. **Clarification** — Classifies the question confidence as high/medium/low. Low-confidence questions suspend the pipeline and post clarifying questions back to the user. Medium/high proceed with any assumptions noted.
2. **Retrieval** — Loads cached sample rows for relevant tables to give the SQL generator concrete data examples.
3. **SQL Generation + Supervisor Loop** — The primary agent generates BigQuery SQL, then a supervisor agent reviews it. If the supervisor rejects, the primary agent retries with the critique (up to 2 retries). Verdicts: `pass`, `fail_then_pass`, or `exhausted`.
4. **Validation (L1–L4)** — Four sequential validation layers:
   - **L1 Static Analysis** — Regex-based blocking of DML/DDL keywords, multi-statement queries, and SQL comments
   - **L2 AST Validation** — Parses the SQL into an AST to verify it's a valid single SELECT
   - **L3 Dry Run** — BigQuery dry run to catch syntax errors and estimate bytes scanned
   - **L4 Cost Gate** — Rejects queries exceeding the configured byte scan limit
5. **Execution** — Runs the query against BigQuery with timeout and row limits.
6. **Format + Respond** — Chooses a response format (single value, table, zero rows) and posts Slack blocks with the SQL, explanation, and feedback buttons.
7. **Persist** — Saves the full response context (SQL, explanation, confidence, reasoning chain, trace ID) to Firestore.

All queries are read-only. The bot cannot modify data.

### Confidence Reconciliation

Final confidence is the minimum of the primary agent's confidence and the supervisor's confidence (`src/agents/confidence.ts`). This ensures that disagreement between the two agents always results in a more conservative confidence level.

### Teachings (Knowledge Base)

The bot can be taught domain-specific knowledge (business definitions, metric formulas, table relationships) via YAML files in `teachings/`. The sync script parses these files, uploads them to Gemini File Search for RAG retrieval, and writes summary embeddings to Firestore.

Teaching summaries are cached in memory and refreshed every 5 minutes. The SQL generator uses them as grounding context alongside the dbt schema.

To sync teachings after editing YAML files:

```bash
npx tsx scripts/sync-teachings.ts
```

This is also run automatically by the `sync-teachings` GitHub Actions workflow.

### Feedback Loop

Responses include thumbs up/down buttons. Feedback is recorded in Firestore. On negative feedback, the user can reply in the thread — the bot detects this as a follow-up, loads the previous (rejected) SQL as a negative example, and re-runs the pipeline to generate a corrected query.

The "Wrong assumptions?" button prompts the user to correct the bot's assumptions in-thread, triggering the same re-run flow.

### Clarification Flow

When the clarification agent classifies a question as low-confidence, the pipeline:

1. Posts clarifying questions with interactive buttons
2. Saves the clarification state (original question, ambiguities) to Firestore
3. Suspends — no SQL is generated

When the user replies in the thread, `checkClarificationReply` detects the pending state and resumes the pipeline with the clarified question.

## Prerequisites

- **Node.js 20+**
- **GCP project** with BigQuery, Firestore, Secret Manager, Cloud Run, and Artifact Registry APIs enabled
- **Slack app** with Bot Token and Signing Secret ([Slack app setup guide](https://api.slack.com/start))
- **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey)
- **dbt artifacts** (`manifest.json` and `catalog.json`) generated from your dbt project

### Slack App Configuration

The Slack app needs these features enabled:

**Event Subscriptions** (request URL: `https://<your-cloud-run-url>/slack/events`):
- `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`

**Slash Commands:** `/anna` pointing to `https://<your-cloud-run-url>/slack/events`

**Bot Token Scopes** (derived from the features above):
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
    supervisorLoop.ts     # Generate → review → retry loop
    confidence.ts         # Confidence reconciliation logic
    followUpClassifier.ts # Thread follow-up detection
  validation/             # 4-layer SQL validation
    pipeline.ts           # L1→L2→L3→L4 orchestrator
    staticAnalysis.ts     # L1: Regex keyword blocking
    astValidation.ts      # L2: SQL AST parse check
    dryRun.ts             # L3: BigQuery dry run
    costGate.ts           # L4: Byte scan limit
  execution/              # Query execution
    runner.ts             # BigQuery query runner
    formatter.ts          # Response format chooser
  dbt/                    # dbt metadata
    parser.ts             # manifest.json + catalog.json parser
    sampleRowCache.ts     # Cached sample rows for prompt context
  teachings/              # Knowledge base system
    parser.ts             # YAML teaching file parser
    summaryMap.ts         # In-memory summary cache + Firestore sync
    fileSearchSync.ts     # Gemini File Search upload
    markdownConverter.ts  # Teaching → markdown for File Search
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
  sync-teachings.ts       # Teaching YAML → File Search + Firestore sync
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
GET /health → 200 OK
```
