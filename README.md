# Anna Lytics

A Slack bot that answers business questions by translating natural language into BigQuery SQL. Uses dbt metadata as a semantic layer, Gemini 3.0 Pro for SQL generation, and RAG via Gemini File Search for domain-specific knowledge.

## Architecture

### Pipeline Stages

Users ask questions in Slack via `@Anna Lytics`, `/anna`, DMs, or thread replies. Each question flows through a 7-stage pipeline (`src/pipeline.ts`):

1. **Clarification** — Classifies question confidence as high/medium/low. Low-confidence questions suspend the pipeline and respond to requestor (or channel) with clarifying questions. Medium/high proceed with assumptions noted.
2. **Retrieval** — Loads two context sources for the SQL generator: cached sample rows (concrete data examples per table) and summaries from the knowledge base (business definitions, metric formulas, sanctioned SQL patterns).
3. **SQL Generation + Supervisor Loop** — The primary agent generates BigQuery SQL using dbt schema, sample rows, and RAG-retrieved teachings as context. A supervisor agent then reviews it; if supervisor rejection, the primary agent retries with the supervisor critique (up to 2 retries).
4. **Escalation Decision** — If the supervisor loop exhausts retries, the bot either shows a best-effort answer with a caveat (medium/high confidence) or parks the thread and asks the data team (low confidence). Escalation state is persisted to Firestore for async resume when a human responds.
5. **Validation (L1-L4)** — Four sequential validation layers:
   - **L1 Static Analysis** — Blocks DML/DDL, multi-statement queries, and SQL comments
   - **L2 AST Validation** — Parses SQL into an AST to verify it's a single SELECT
   - **L3 Dry Run** — BigQuery dry run for syntax errors and byte-scan estimation
   - **L4 Cost Gate** — Rejects queries exceeding the configured scan limit
   If validation fails, the pipeline retries SQL generation once with the error as a self-correction prompt.
6. **Execution** — Runs the validated query against BigQuery with timeout and row limits.
7. **Format + Respond** — Posts Slack blocks with the result (single value, table, or zero-row message), the SQL, an explanation, feedback buttons, reasoning toggle, and response override buttons (Table, Summary, CSV).
8. **Persist** — Saves the full response context (SQL, explanation, confidence, reasoning chain, trace ID, all considered table schemas) to Firestore.

All queries are read-only. The bot cannot modify data.

### dbt as a Semantic Layer

The bot uses dbt's `manifest.json` and `catalog.json` as its understanding of the data warehouse. At startup, `src/dbt/parser.ts` merges both artifacts into an in-memory array of `TableContext` objects (one per dbt model). Each object carries materialization type, DAG dependencies, and a synthetic DDL statement (`CREATE TABLE ...`) that combines column names, data types (from `catalog.json`), and descriptions (from dbt YAML) as inline comments. This DDL is injected directly into the SQL generator's system prompt.

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

### Human-in-the-Loop Escalation

When the supervisor loop can't approve a query after retries, the bot escalates to a human:

- **Park + Wait** (low confidence): Tells the user "I've asked the data team", posts the question with full context to a configurable escalation channel (or DM), and suspends the pipeline. When the analyst replies in the escalation thread, the bot resumes the pipeline with their guidance and posts the result to the original thread.
- **Best-Effort + Verify** (medium/high confidence): Executes the query and shows results with a visible caveat, then posts to the escalation channel for async verification. If the analyst confirms or corrects, the bot posts their response to the original thread.

Escalation state is persisted to Firestore (`escalation_state` collection) so the pipeline can suspend and resume across separate Cloud Run requests. Reminders are posted to the escalation channel after a configurable interval (default 30 min). Escalations time out after a configurable duration (default 4 hours) with appropriate messages to the user.

A shared `preflightChecks()` function prevents new pipeline runs in threads with pending escalations or clarifications.

### Follow-Up Intent Routing

Thread replies are classified into four intents before entering the pipeline:

- **Meta-question** ("Why did you use that table?") — Answers from the persisted ResponseContext using Gemini Flash. No SQL generation, no supervisor. Includes all tables the bot considered (not just those used), teachings referenced, and supervisor notes.
- **Refinement** ("Break that down by region") — Constructs a composite question from the original + refinement, passes the previous SQL as a starting-point hint, and re-runs the full pipeline.
- **Discrepancy** ("If total is $5M, how come Q4 is only $800K?") — Generates diagnostic SQL via Gemini Pro, runs through validation and a lightweight supervisor review, executes, and presents findings in plain language.
- **New query** — Standard pipeline.

### Reasoning Transparency

Every response includes interactive buttons:

- **Reasoning toggle** — "Show reasoning" appends tables used, teachings referenced, supervisor assessment, and confidence to the message. "Hide reasoning" collapses it. No LLM calls — all data from persisted ResponseContext.
- **Response overrides** — "Table", "Summary", and "CSV" buttons re-execute the original SQL (leveraging BigQuery's 24-hour cache) and re-render in the chosen format. Summary uses a Gemini Flash call; if it fails, falls back to table format.

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
`app_mentions:read`, `channels:history`, `chat:write`, `commands`, `files:write`, `groups:history`, `im:history`, `mpim:history`

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
  agents/                 # LLM agents (never import from slack/ or state/)
    clarificationAgent.ts # Question classification (high/medium/low)
    sqlGenerator.ts       # Primary SQL generation agent
    supervisorAgent.ts    # SQL review agent
    supervisorLoop.ts     # Generate -> review -> retry loop
    confidence.ts         # Confidence reconciliation logic
    followUpClassifier.ts # Thread follow-up detection
    escalationDecision.ts # Pure function: supervisor result -> escalation behavior
    metaQuestionHandler.ts# Flash LLM: explain reasoning from ResponseContext
    refinementHandler.ts  # Build composite question for pipeline re-run
    discrepancyHandler.ts # Pro LLM: generate diagnostic SQL
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
    blocks.ts             # Response blocks (table, single value, feedback, overrides)
    clarificationBlocks.ts# Clarification question blocks
    escalationBlocks.ts   # Escalation channel messages and reminders
    reasoningBlocks.ts    # Show/hide reasoning toggle content
    threadContext.ts       # Thread history summarizer
  state/                  # Firestore-backed state
    firestore.ts          # Firestore client singleton
    responseContext.ts     # Response persistence + feedback recording + retrieval
    clarificationState.ts # Pending clarification state (suspend/resume)
    escalationState.ts    # Escalation state CRUD (suspend/resume/timeout)
    threadLock.ts         # Per-thread concurrency lock
    rateLimiter.ts        # Per-user rate limiting
  handlers/               # Slack event handlers
    commands.ts           # /anna slash command
    mentions.ts           # @Anna Lytics mentions
    messages.ts           # DMs and thread replies
    preflightChecks.ts    # Shared guard: lock + clarification + escalation
    followUpRouter.ts     # Route follow-up intents to handlers
    escalationResponse.ts # Handle human replies in escalation channel
    escalationLifecycle.ts# Reminder posting and timeout detection
    responseOverrides.ts  # Table/Summary/CSV button handlers
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
| `ESCALATION_MODE` | No | `channel` | Escalation target: `channel` or `dm` |
| `ESCALATION_CHANNEL_ID` | No | | Slack channel ID for escalation messages |
| `ESCALATION_ANALYST_USER_ID` | No | | Slack user ID for DM-mode escalation |
| `ESCALATION_REMINDER_MINUTES` | No | `30` | Minutes between escalation reminders |
| `ESCALATION_TIMEOUT_HOURS` | No | `4` | Hours before escalation times out |

## Health Check

```
GET /health -> 200 OK
```
