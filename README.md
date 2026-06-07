# Anna Lytics

Anna Lytics is a Slack bot that answers business questions by translating natural-language questions into read-only BigQuery SQL. It uses dbt metadata as the semantic layer, configurable Gemini model aliases for generation and review, and Gemini File Search for domain-specific knowledge.

## Architecture

Users ask questions in Slack via `@Anna Lytics`, `/anna`, DMs, or thread replies. Each request flows through `src/pipeline.ts`:

1. **Clarification** - Classifies confidence and asks follow-up questions when the request is too ambiguous.
2. **Retrieval** - Loads dbt schema context, cached sample rows, teaching summaries, and Gemini File Search knowledge.
3. **SQL generation and supervisor loop** - Generates SQL with Gemini Pro and retries when supervisor review rejects the query.
4. **Escalation decision** - Parks low-confidence exhausted requests for human review or returns best-effort answers with caveats.
5. **Validation** - Runs L1 static checks, L2 AST parsing, L3 BigQuery dry run, and L4 byte-cost gate.
6. **Execution** - Runs validated read-only SQL in BigQuery with timeout and row limits.
7. **Response** - Posts Slack blocks with result, SQL, explanation, feedback, reasoning toggle, and output overrides.
8. **Persistence** - Saves response context, clarification state, escalation state, rate limits, and locks in Firestore.

All generated queries must be SELECT-only. The bot cannot modify warehouse data.

## Prerequisites

- Node.js 20+ and npm.
- Docker for image builds.
- `gcloud` CLI for local ADC, Secret Manager setup, and Cloud Run deploy.
- A GCP project with BigQuery, Firestore Native, Secret Manager, Cloud Run, and Artifact Registry APIs enabled.
- A Slack app with a bot token and signing secret.
- A Gemini Developer API key from Google AI Studio.
- dbt artifacts from the warehouse project.
- Optional: Terraform or OpenTofu for persistent infrastructure setup.

## Knowledge Model

The bot has two knowledge sources:

- **dbt artifacts** in `dbt/manifest.json` and `dbt/catalog.json`. These are loaded at startup and become the allowed table/column context.
- **Knowledge YAML** in `references/` and optionally `teachings/`. `references/` is the current primary authoring surface for typed ReferenceCards. Legacy teachings remain supported for summary-map compatibility and approved escalation learnings.

This repository is a template. The included ReferenceCards and benchmark corpus are starter examples, not a prescription for every implementation. Replace them with one narrow implementation-specific domain before syncing File Search or recording an acceptance decision.

Run validation before syncing or deploying:

```bash
npm run knowledge:validate
```

Manual File Search sync uses the full knowledge pipeline:

```bash
npm run knowledge:sync
# equivalent direct command: npx tsx scripts/sync-knowledge.ts
```

The GitHub workflow is named **Sync Knowledge** and uploads ReferenceCards plus teachings to Gemini File Search. The older `scripts/sync-teachings.ts` script is retained for legacy teaching-only maintenance and is not the primary sync path.

### File Search Setup

`FILE_SEARCH_STORE_ID` must point to an existing Gemini File Search store, for example `fileSearchStores/<store-name>`. Store creation is separate from document upload: a store can exist while containing zero synced documents.

For acceptance runs, `FILE_SEARCH_STORE_ID` is required because the benchmark corpus expects ReferenceCard retrieval evidence. `npm run knowledge:sync` retries transient Gemini File Search upload errors, removes existing managed documents for the incoming display names before replacement upload, polls upload operations, retries documents that fail indexing, verifies newly uploaded documents reach `STATE_ACTIVE`, cleans up replaced managed documents, and requires final readback convergence. Managed File Search documents are those with `teaching:` or `reference_card:` display names; other documents in the store are ignored by cleanup. Replacement is not atomic because old managed documents are removed before new uploads are verified, so rerun sync before relying on the store if upload or verification fails. A successful sync reports `Uploaded == Verified == Active`, `Errors: 0`, and one active File Search document per expected display name with no failed or duplicate managed documents remaining. If sync still reports upload, verification, or cleanup convergence errors, do not record an `ACCEPTED` decision; rerun sync and verify documents are retrievable first.

Repeated `500 INTERNAL`, `503 UNAVAILABLE`, `504 DEADLINE_EXCEEDED`, or `429 RESOURCE_EXHAUSTED` responses usually indicate transient Gemini File Search upload instability, not Firestore or Slack setup. The sync must still fail after retry exhaustion because a store ID existing is not the same thing as successful upload and indexing.

## Slack App Configuration

Configure the Slack app before deploying the Cloud Run service.

In the Slack app configuration at https://api.slack.com/apps, select your app
and configure these sections.

### Event Subscriptions

Go to **Features -> Event Subscriptions**, turn on **Enable Events**, and set
the request URL:

```text
https://<your-cloud-run-url>/slack/events
```

Subscribe to these bot events:

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

Plain 1:1 DMs are delivered through `message.im`. Group DMs are delivered
through `message.mpim`. Channel messages require `app_mention` unless the bot
has already participated in the thread.

### App Home Messages

Go to **Features -> App Home** and enable the **Messages** tab. If users see
`Sending messages to this app has been turned off`, the Messages tab or message
input for the app is disabled in this section. Enable **Allow users to send
Slash commands and messages from the messages tab** before testing DMs.

### Slash Command

Go to **Features -> Slash Commands** and create:

```text
/anna -> https://<your-cloud-run-url>/slack/events
```

### Interactivity

Go to **Features -> Interactivity & Shortcuts**, turn on interactivity, and use
the same request URL:

```text
https://<your-cloud-run-url>/slack/events
```

This is required for feedback buttons, reasoning toggles, and output override
buttons. If a user clicks one and Slack shows `This app is not configured to
handle interactive responses`, interactivity is off or the request URL is
unset here — the bot's other replies are unaffected because Event Subscriptions
is a separate toggle.

### OAuth Scopes

Go to **Features -> OAuth & Permissions** and add these bot token scopes:

```text
app_mentions:read
channels:history
chat:write
commands
files:write
groups:history
im:history
mpim:history
```

After changing scopes, event subscriptions, slash commands, App Home settings,
or interactivity settings, reinstall the app to the workspace from
**Settings -> Install App**.

### Escalation Target IDs

When a user flags an answer (👎 -> "Wrong number" / "Wrong data"), the bot posts
an escalation card to a human analyst. Configure the destination with
`ESCALATION_MODE` plus one of the two IDs below (see the Configuration table).
Slack IDs are not the display names — copy the raw `C…` / `U…` identifiers:

- **Channel ID** (`ESCALATION_CHANNEL_ID`, for `ESCALATION_MODE=channel`): in
  Slack, right-click the channel -> **View channel details**; the `C…` id is at
  the bottom of the dialog. Or copy the channel link (**Copy link**) and take the
  `C…` segment from `…/archives/C0123ABCD`. **Invite the bot to that channel** —
  it can only post where it is a member.
- **User ID** (`ESCALATION_ANALYST_USER_ID`, for `ESCALATION_MODE=dm`): open the
  analyst's profile -> **... More** -> **Copy member ID** (a `U…` value). The bot
  needs `chat:write` (already in the scopes above) to DM them.

If neither ID resolves for the selected mode, escalation is skipped and 👎 falls
back to silent record-only — no reason prompt is shown.

### Slack Smoke Tests

After deployment and app reinstall:

1. Confirm `GET https://<your-cloud-run-url>/health` returns `200 OK`.
2. Confirm Slack verifies the Event Subscriptions request URL.
3. Open the app's Messages tab and send a DM. If Slack says message sending is
   turned off, recheck **Features -> App Home -> Messages**.
4. Mention the bot in a private test channel with `@Anna Lytics <question>`.
5. Run `/anna <question>` in the same test channel.

## Local Development

Install dependencies and create a local env file:

```bash
npm install
cp .env.example .env
```

Local runs use Application Default Credentials for BigQuery and Firestore:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project "$GCP_PROJECT_ID"
```

The ADC principal can differ from the active `gcloud` account. For local development it needs:

- `roles/datastore.user` for Firestore state.
- `roles/bigquery.jobUser` for query jobs and dry runs.
- `roles/bigquery.dataViewer` for warehouse reads.
- `roles/bigquery.readSessionUser` when generating dbt docs against BigQuery with the Storage API.

Generate dbt artifacts from the dbt project and copy them into this repo:

```bash
cd /path/to/your-dbt-project
dbt compile && dbt docs generate
cp target/manifest.json target/catalog.json /path/to/annalytics/dbt/
```

The implementation dbt artifacts must align with `references/` and `benchmarks/corpus.json`. If ReferenceCards mention tables absent from the copied dbt artifacts, `npm run knowledge:validate` fails. The template gitignores `dbt/manifest.json` and `dbt/catalog.json` so client schema is not accidentally committed here; implementation repositories can choose their own artifact delivery model.

Run the local setup preflight without printing secret values:

```bash
npm run setup:check
```

Run the app and tests:

```bash
npm run dev
npm run typecheck
npm test
npm run lint
```

## Infrastructure Setup

The supported runtime deploy path is direct `gcloud` deployment. Terraform in `infra/` is optional and only manages persistent setup:

- Required GCP APIs.
- Firestore Native database.
- Firestore composite indexes derived from `infra/firestore.indexes.json`.
- Artifact Registry repository.
- `anna-lytics` service account and IAM.
- Empty Secret Manager secret containers for runtime secrets.

Terraform does not deploy Cloud Run revisions and does not store secret values in state.

```bash
cd infra
terraform init
terraform apply \
  -var="project_id=your-gcp-project" \
  -var="region=us-west1"
```

If resources already exist because they were created manually, import them before applying Terraform. At minimum, verify the Firestore database, indexes, service account, Artifact Registry repository, and runtime secret containers.

Runtime secret values must be added outside Terraform:

```bash
printf '%s' "$SLACK_BOT_TOKEN" | gcloud secrets versions add slack-bot-token --data-file=- --project "$GCP_PROJECT_ID"
printf '%s' "$SLACK_SIGNING_SECRET" | gcloud secrets versions add slack-signing-secret --data-file=- --project "$GCP_PROJECT_ID"
printf '%s' "$GEMINI_API_KEY" | gcloud secrets versions add gemini-api-key --data-file=- --project "$GCP_PROJECT_ID"
```

Required Secret Manager names:

| Secret Manager secret | Runtime env var |
|-----------------------|-----------------|
| `slack-bot-token` | `SLACK_BOT_TOKEN` |
| `slack-signing-secret` | `SLACK_SIGNING_SECRET` |
| `gemini-api-key` | `GEMINI_API_KEY` |

Validate optional Terraform configuration when Terraform or OpenTofu is installed:

```bash
npm run infra:validate
```

## Deployment

The standard region is `us-west1`.

### Firestore TTL Policy

The runtime stores short-lived locks, clarification state, escalation state, and
Slack event dedupe records in Firestore with `expiresAt` timestamps. Enable TTL
for the Slack event dedupe collection so old retry markers are pruned
automatically:

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=slack_event_dedupe \
  --database="(default)" \
  --enable-ttl \
  --project "$PROJECT_ID"
```

### Automatic

Pushing to `main` triggers `.github/workflows/deploy.yml`:

1. Validates knowledge, setup docs/workflows, TypeScript, and tests.
2. Builds and pushes the Docker image to Artifact Registry.
3. Deploys Cloud Run with explicit project, region, service account, env vars, Secret Manager bindings, port, and unauthenticated Slack endpoint access.

Deployment requires `dbt/manifest.json` and `dbt/catalog.json` to be present in the build workspace. The template workflow fails fast with a clear message if an implementation has not provided those artifacts.

Required GitHub secrets:

| Secret | Description |
|--------|-------------|
| `GCP_PROJECT_ID` | Target GCP project ID |
| `WIF_PROVIDER` | Workload Identity Federation provider resource name |
| `WIF_SERVICE_ACCOUNT` | GitHub Actions deploy service account |
| `GEMINI_API_KEY_CI` | Gemini API key used by Sync Knowledge |
| `FILE_SEARCH_STORE_ID` | Gemini File Search store ID used by sync, deploy, and benchmark runs |

### Manual

```bash
export PROJECT_ID=your-project
export REGION=us-west1
export SERVICE_NAME=anna-lytics
export FILE_SEARCH_STORE_ID=fileSearchStores/your-store

gcloud config set project "$PROJECT_ID"
gcloud auth configure-docker "$REGION-docker.pkg.dev"

docker build -t "$REGION-docker.pkg.dev/$PROJECT_ID/anna-lytics/anna-lytics:latest" .
docker push "$REGION-docker.pkg.dev/$PROJECT_ID/anna-lytics/anna-lytics:latest"

gcloud run deploy "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --image "$REGION-docker.pkg.dev/$PROJECT_ID/anna-lytics/anna-lytics:latest" \
  --region "$REGION" \
  --service-account "$SERVICE_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
  --set-env-vars "GCP_PROJECT_ID=$PROJECT_ID,FILE_SEARCH_STORE_ID=$FILE_SEARCH_STORE_ID,GEMINI_MODEL=gemini-pro-latest,GEMINI_FLASH_MODEL=gemini-flash-latest,GEMINI_JUDGE_MODEL=gemini-pro-latest" \
  --set-secrets "SLACK_BOT_TOKEN=slack-bot-token:latest,SLACK_SIGNING_SECRET=slack-signing-secret:latest,GEMINI_API_KEY=gemini-api-key:latest" \
  --port 3000 \
  --allow-unauthenticated
```

## Updating dbt Metadata

The bot reads dbt metadata from files baked into the container image. To update schema context:

1. Regenerate dbt artifacts with `dbt compile && dbt docs generate`.
2. Copy `target/manifest.json` and `target/catalog.json` to `dbt/`.
3. Run `npm run knowledge:validate`.
4. Run `npm run setup:check`.
5. Commit and push the implementation-specific changes only in the implementation repo or branch where committing those artifacts is intentional.

The `/refresh-metadata` endpoint exists as a placeholder for future live reload support.

## Configuration

All configuration is via environment variables. See `.env.example` for the local template.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | Yes | | Slack bot OAuth token |
| `SLACK_SIGNING_SECRET` | Yes | | Slack request signing secret |
| `GEMINI_API_KEY` | Yes | | Gemini Developer API key |
| `GCP_PROJECT_ID` | Yes | | GCP project for BigQuery and Firestore |
| `GEMINI_MODEL` | No | `gemini-pro-latest` | SQL generation and supervisor model |
| `GEMINI_FLASH_MODEL` | No | `gemini-flash-latest` | Lightweight classification and summary model |
| `GEMINI_JUDGE_MODEL` | No | `GEMINI_MODEL` | Benchmark judge model |
| `FILE_SEARCH_STORE_ID` | No for runtime, yes for sync/acceptance | | Gemini File Search store for ReferenceCards and teachings |
| `DBT_MANIFEST_PATH` | No | `./dbt/manifest.json` | Path to dbt manifest |
| `DBT_CATALOG_PATH` | No | `./dbt/catalog.json` | Path to dbt catalog |
| `DBT_WEBHOOK_SECRET` | No | | Enables `POST /api/dbt-run-results` when set |
| `PORT` | No | `3000` | HTTP port |
| `COST_GATE_MAX_BYTES` | No | `10737418240` | Max bytes a query can scan |
| `QUERY_TIMEOUT_MS` | No | `30000` | Query execution timeout |
| `MAX_RESULT_ROWS` | No | `1000` | Max rows returned |
| `RATE_LIMIT_PER_HOUR` | No | `30` | Queries per user per hour |
| `LOG_LEVEL` | No | `info` | pino log level |
| `ESCALATION_MODE` | No | `channel` | Escalation target: `channel` or `dm` |
| `ESCALATION_CHANNEL_ID` | No | | Slack channel ID for escalation messages |
| `ESCALATION_ANALYST_USER_ID` | No | | Slack user ID for DM-mode escalation |
| `ESCALATION_REMINDER_MINUTES` | No | `30` | Minutes between escalation reminders |
| `ESCALATION_TIMEOUT_HOURS` | No | `4` | Hours before escalation times out |
| `ESCALATION_ON_NEGATIVE_FEEDBACK` | No | `true` | Route 👎 "wrong number"/"wrong data" flags to the analyst (needs a resolved target) |

## Project Structure

```text
src/                 Runtime app, agents, validation, Slack handlers, and Firestore state
references/          Primary typed ReferenceCard knowledge YAML
teachings/           Optional legacy teaching YAML, when present
dbt/                 Implementation-provided dbt manifest/catalog artifacts
scripts/             Validation, sync, benchmark, and setup guardrail scripts
benchmarks/          Benchmark corpus and generated result artifacts
infra/               Optional persistent GCP setup, not runtime deploy
```

## Health Check

```text
GET /health -> 200 OK
```
