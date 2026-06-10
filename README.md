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
- Node.js (used to run the index-manifest helper during persistent setup).

## Knowledge Model

The bot has two knowledge sources:

- **dbt artifacts** in `dbt/manifest.json` and `dbt/catalog.json`. These are loaded at startup and become the allowed table/column context.
- **Knowledge YAML** in `references/` and optionally `teachings/`. `references/` is the current primary authoring surface for typed ReferenceCards. Legacy teachings remain supported for summary-map compatibility and approved escalation learnings.

This repository is a template. The included ReferenceCards and benchmark corpus are starter examples, not a prescription for every implementation. Replace them with one narrow implementation-specific domain before syncing File Search or recording an acceptance decision.

Run strict validation before syncing File Search, recording acceptance evidence, or treating an implementation schema as aligned:

```bash
npm run knowledge:validate
```

`npm run setup:check` is a local preflight and may warn, rather than fail, when starter/template ReferenceCards or teachings do not match the current local dbt artifacts. Those warnings are acceptable for template setup, but not for implementation knowledge sync.

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
- `reaction_added`

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
im:write
mpim:history
reactions:read
```

`im:write` is required for `ESCALATION_MODE=dm` — the bot opens a direct message
with the analyst to deliver escalation cards. Channel-mode escalation does not
need it.

`reactions:read` is required for the escalation card's ✅ quick-path — an analyst
reacting ✅ to a pending escalation card confirms the proposed SQL and resolves
the escalation. Harmless to omit: the bot simply never receives the
`reaction_added` event, and analysts can still resolve escalations by replying in
the thread.

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
  needs both `chat:write` and `im:write` (already in the scopes above) to open and
  post the DM. The analyst must also be a member of the workspace the bot is installed in.

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
6. Trigger a test escalation (👎 -> "Wrong number" on an answer), react ✅ on the
   escalation card, and confirm the original thread receives the resolution. If
   nothing happens, recheck the `reactions:read` scope and the `reaction_added`
   event subscription, then reinstall the app.

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

The implementation dbt artifacts must align with `references/`, optional `teachings/`, and `benchmarks/corpus.json` before File Search sync or acceptance runs. If knowledge YAML mentions tables absent from the copied dbt artifacts, `npm run knowledge:validate` fails. `npm run setup:check` reports the same mismatch as a warning so template users can still verify local wiring when starter examples and local artifacts are intentionally out of sync. The template gitignores `dbt/manifest.json` and `dbt/catalog.json` so client schema is not accidentally committed here; implementation repositories can choose their own artifact delivery model.

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

Persistent GCP setup is provisioned manually with `gcloud`. The Terraform config
in `infra/` is **not** the assumed deploy path — it is retained only as an
optional, declarative reference (and `infra/firestore.indexes.json` doubles as
the canonical list of required Firestore indexes). Nothing in this repo runs
`terraform apply`; CI and the runtime deploy use `gcloud` only.

The persistent resources, all created once per project:

- Required GCP APIs.
- Firestore Native database.
- Firestore composite indexes (manifest: `infra/firestore.indexes.json`).
- Artifact Registry repository (`anna-lytics`, Docker format).
- `anna-lytics` service account and IAM.
- Secret Manager secret containers for runtime secrets.

Set your target project and region first:

```bash
export GCP_PROJECT_ID="your-gcp-project"
export REGION="us-west1"
```

### 1. Enable APIs

```bash
gcloud services enable \
  run.googleapis.com firestore.googleapis.com bigquery.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com \
  --project "$GCP_PROJECT_ID"
```

### 2. Firestore database

```bash
gcloud firestore databases create --location="$REGION" --type=firestore-native \
  --project "$GCP_PROJECT_ID"
```

### 3. Firestore composite indexes

Single-field indexes are created automatically by Firestore. The multi-field
composite indexes must be created explicitly. This one-liner emits a
`gcloud firestore indexes composite create` command for every composite index
declared in the manifest, so it stays in sync with `infra/firestore.indexes.json`:

```bash
node -e 'JSON.parse(require("fs").readFileSync("infra/firestore.indexes.json")).indexes.filter(i=>i.fields.length>1).forEach(i=>console.log("gcloud firestore indexes composite create --collection-group="+i.collectionGroup+" --query-scope="+i.queryScope+" "+i.fields.map(f=>"--field-config=field-path="+f.fieldPath+",order="+f.order.toLowerCase()).join(" ")+" --project=\"$GCP_PROJECT_ID\""))'
```

Review the printed commands, then pipe them to a shell to apply (creating an
index that already exists is a safe no-op):

```bash
node -e '...' | sh   # same one-liner as above, piped to sh
```

Verify what is live at any time:

```bash
gcloud firestore indexes composite list --project "$GCP_PROJECT_ID"
```

### 4. Artifact Registry

```bash
gcloud artifacts repositories create anna-lytics --repository-format=docker \
  --location="$REGION" --project "$GCP_PROJECT_ID"
```

### 5. Service account and IAM

```bash
gcloud iam service-accounts create anna-lytics --display-name="Anna Lytics Bot" \
  --project "$GCP_PROJECT_ID"

SA="anna-lytics@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
for ROLE in roles/bigquery.dataViewer roles/bigquery.jobUser roles/datastore.user; do
  gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
    --member="serviceAccount:${SA}" --role="$ROLE"
done
```

### 6. Secret Manager

Create the secret containers, grant the service account access, then add values:

```bash
SA="anna-lytics@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
for SECRET in slack-bot-token slack-signing-secret gemini-api-key; do
  gcloud secrets create "$SECRET" --replication-policy=automatic --project "$GCP_PROJECT_ID"
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:${SA}" --role=roles/secretmanager.secretAccessor \
    --project "$GCP_PROJECT_ID"
done

printf '%s' "$SLACK_BOT_TOKEN"      | gcloud secrets versions add slack-bot-token      --data-file=- --project "$GCP_PROJECT_ID"
printf '%s' "$SLACK_SIGNING_SECRET" | gcloud secrets versions add slack-signing-secret --data-file=- --project "$GCP_PROJECT_ID"
printf '%s' "$GEMINI_API_KEY"       | gcloud secrets versions add gemini-api-key       --data-file=- --project "$GCP_PROJECT_ID"
```

Required Secret Manager names:

| Secret Manager secret | Runtime env var |
|-----------------------|-----------------|
| `slack-bot-token` | `SLACK_BOT_TOKEN` |
| `slack-signing-secret` | `SLACK_SIGNING_SECRET` |
| `gemini-api-key` | `GEMINI_API_KEY` |

### 7. Cloud Scheduler lifecycle sweep (optional)

With `LIFECYCLE_SWEEP_SECRET` set on the service, create a Cloud Scheduler job
that hits `POST /api/lifecycle-sweep` every 10 minutes so escalation reminders
and timeouts fire on wall-clock time. Replace `<service-url>` with the deployed
Cloud Run service URL:

```bash
gcloud services enable cloudscheduler.googleapis.com --project "$GCP_PROJECT_ID"

gcloud scheduler jobs create http anna-lytics-lifecycle-sweep \
  --schedule="*/10 * * * *" \
  --uri="<service-url>/api/lifecycle-sweep" \
  --http-method=POST \
  --headers="Authorization=Bearer ${LIFECYCLE_SWEEP_SECRET}" \
  --location="$REGION" \
  --project "$GCP_PROJECT_ID"
```

Two operational gotchas, both observed in practice:

- `gcloud scheduler jobs create` (and `describe`) print the job config
  **including the `Authorization` header**. If that output landed anywhere
  persistent (terminal log, session transcript, CI log), rotate: add a new
  secret version, disable the leaked one, update the job's header — and roll a
  new Cloud Run revision, because secret env vars pinned to `latest` resolve at
  instance startup, not per request.
- Binding `LIFECYCLE_SWEEP_SECRET` with `--update-secrets` creates a
  config-only revision that reuses the **currently deployed image**. If that
  image predates this endpoint, every sweep returns 404. After creating the
  job, verify end-to-end: `gcloud scheduler jobs run <job>` and confirm a 200
  with sweep counts in the service logs.

Skipping this step keeps today's event-traffic-only behavior: escalation
reminders and timeouts only fire when someone messages the bot. With the
scheduler in place, the worst-case timeout-notification latency roughly equals
the sweep interval (10 minutes as configured above; the in-module 60s throttle
can add up to a minute when an event-driven sweep collides with a scheduled
tick). The endpoint returns the sweep counts as JSON; a `throttled: true`
response means a recent sweep already ran — try again in a minute — not that
nothing was pending.

## Deployment

The standard region is `us-west1`.

### Firestore TTL Policy

The runtime writes a retention timestamp on every document in a growth-prone
collection. A few collections are intentionally unbounded and absent from the
manifest: `rate_limits` (bounded sliding window, overwritten in place per
user), `teaching_candidates` and `feedback_notes` (human-drained queues), and
`config` (singleton metadata docs). Most
collections (locks, clarification state, caches, Slack event dedupe, dbt run
history, `response_context`) use `expiresAt`; for `response_context` the window
is `RESPONSE_CONTEXT_RETENTION_DAYS` (default 90 days). `escalation_state`
retention uses `retainUntil` (fixed 90 days) because its `expiresAt` is the
escalation timeout, not a retention deadline. The manifest
`infra/firestore.ttls.json` is the source of truth for which field each
collection group's TTL policy targets. This one-liner emits a
`gcloud firestore fields ttls update` command for every entry, so it stays in
sync with the manifest:

```bash
node -e 'JSON.parse(require("fs").readFileSync("infra/firestore.ttls.json")).ttls.forEach(t=>console.log("gcloud firestore fields ttls update "+t.field+" --collection-group="+t.collectionGroup+" --database=\"(default)\" --enable-ttl --project=\"$GCP_PROJECT_ID\""))'
```

Review the printed commands, then pipe them to a shell to apply (enabling a TTL
that is already enabled is a safe no-op):

```bash
node -e '...' | sh   # same one-liner as above, piped to sh
```

Verify what is live at any time:

```bash
gcloud firestore fields ttls list --database="(default)" --project "$GCP_PROJECT_ID"
```

TTL deletion is best-effort: Firestore typically removes expired documents
within ~72 hours of expiry, not at the deadline. That is why the runtime keeps
its check-on-read guards (lock expiry, clarification/escalation staleness,
cache freshness) — TTL is cleanup, not correctness.

Documents written before retention fields existed lack the targeted field and
will never be TTL-deleted. For pre-existing deployments, run the optional
backfill (dry-run by default; add `--apply` to write). If you changed
`RESPONSE_CONTEXT_RETENTION_DAYS` on the deployed service, set it in your
shell when running the backfill so backfilled deadlines match new writes:

```bash
npx tsx scripts/backfill-retention-fields.ts --project "$GCP_PROJECT_ID"
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
  --set-env-vars "GCP_PROJECT_ID=$PROJECT_ID,FILE_SEARCH_STORE_ID=$FILE_SEARCH_STORE_ID,GEMINI_MODEL=gemini-3.1-pro-preview,GEMINI_FLASH_MODEL=gemini-3-flash-preview,GEMINI_JUDGE_MODEL=gemini-3.1-pro-preview" \
  --set-secrets "SLACK_BOT_TOKEN=slack-bot-token:latest,SLACK_SIGNING_SECRET=slack-signing-secret:latest,GEMINI_API_KEY=gemini-api-key:latest" \
  --port 3000 \
  --allow-unauthenticated
```

## Updating dbt Metadata

The bot reads dbt metadata from files baked into the container image. To update schema context:

1. Regenerate dbt artifacts with `dbt compile && dbt docs generate`.
2. Copy `target/manifest.json` and `target/catalog.json` to `dbt/`.
3. Run `npm run knowledge:validate`.
4. Run `npm run setup:check`; treat table-reference warnings as acceptable only for template/example setup, not for implementation readiness.
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
| `GEMINI_MODEL` | No | `gemini-3.1-pro-preview` | SQL generation and supervisor model |
| `GEMINI_FLASH_MODEL` | No | `gemini-3-flash-preview` | Lightweight classification and summary model |
| `GEMINI_JUDGE_MODEL` | No | `GEMINI_MODEL` | Benchmark judge model |
| `FILE_SEARCH_STORE_ID` | No for runtime, yes for sync/acceptance | | Gemini File Search store for ReferenceCards and teachings |
| `DBT_MANIFEST_PATH` | No | `./dbt/manifest.json` | Path to dbt manifest |
| `DBT_CATALOG_PATH` | No | `./dbt/catalog.json` | Path to dbt catalog |
| `DBT_WEBHOOK_SECRET` | No | | Enables `POST /api/dbt-run-results` when set |
| `LIFECYCLE_SWEEP_SECRET` | No | | Enables `POST /api/lifecycle-sweep` when set (scheduler-driven escalation reminders/timeouts) |
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
