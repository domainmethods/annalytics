# IMPLEMENTATION.md — Template → Implementation Checklist

Anna Lytics ships as a **template**: generic pipeline, starter knowledge content, mock benchmark artifacts, and no client identifiers. This checklist is the ordered path for converting it into a running **implementation** for one analytics team.

This document sequences the work and points to the authoritative source for each step — it delegates runtime commands to the README. The README owns infrastructure and deployment commands; `docs/trajectory-governance.md` owns sequencing rules and what is allowed to land next.

## 0. Declare the boundary

- [ ] Fork or branch this repository for your implementation. From this point on, committing client-specific content (dbt artifacts, project IDs, File Search store IDs, ReferenceCards, corpus retargets, benchmark evidence) is **intentional and expected** — the template boundary (trajectory-governance, "Template decision on 2026-06-05") applies to the template repo, not to you.
- [ ] Note in your fork's `docs/trajectory-governance.md` that the repo is now an implementation repo.

## 1. GCP infrastructure (once per project)

- [ ] Follow README **"Infrastructure Setup"** steps 1–6: enable APIs, create the Firestore database, apply the composite indexes from the `infra/firestore.indexes.json` manifest (the README has a one-liner that generates the `gcloud` commands), create the Artifact Registry repo, the service account + IAM, and the Secret Manager containers.
- [ ] Apply the Firestore TTL policies per README **"Firestore TTL Policy"**. The `infra/firestore.ttls.json` manifest is the source of truth for every retained collection (including `response_context`); the README has a one-liner that generates the `gcloud` commands from it.

## 2. Slack app

- [ ] Configure the Slack app per README **"Slack App Configuration"**: event subscriptions, OAuth scopes, the `/anna` slash command, interactivity URL, and App Home settings.
- [ ] Resolve and set the escalation target per README **"Escalation Target IDs"** (`ESCALATION_MODE` + channel ID or analyst user ID).
- [ ] Run the README **"Slack Smoke Tests"** after first deploy.

## 3. dbt artifacts

- [ ] Generate artifacts from your dbt project (`dbt compile && dbt docs generate`) and copy `manifest.json` / `catalog.json` into `dbt/`, per README **"Updating dbt Metadata"**.
- [ ] Commit them (intentional in an implementation repo). The CI deploy workflow fails fast without them because they are COPY'd into the container at build time.
- [ ] If you choose to keep artifacts out of git anyway, you must build the image locally per README **"Deployment → Manual"** — a cloud build from a clean checkout will not contain gitignored artifacts.

## 4. Knowledge layer — one domain first

Trajectory rule: **one high-confusion domain, 5–10 cards, before any expansion** (trajectory-governance, Active Tranche A and guardrail #2).

- [ ] Pick the domain. If you have production feedback signal, use the per-domain pain ranking (`src/feedback/`); otherwise use analyst judgment.
- [ ] Author your domain's ReferenceCards at `references/<domain>.live.yml` (gitignored), using the starter sample at `references/examples/revenue.yml` (not live-loaded) as a model. The card schema lives in `src/references/`; field-by-field guidance is in the trajectory-governance Evidence Log (2026-06-04 entry).
- [ ] Author initial teachings using `docs/teaching-interview-prompt.md`.
- [ ] Create a Gemini File Search store (README **"File Search Setup"**) and set `FILE_SEARCH_STORE_ID`.
- [ ] Run `npm run knowledge:validate` — for an implementation, treat table-reference **warnings as failures**, not acceptable noise.
- [ ] Sync with `npm run knowledge:sync`, or push to `main` with the GitHub secrets set so the Sync Knowledge workflow runs. Sync success criteria are strict (active-document readback convergence) — see trajectory-governance, Active Tranche A.

## 5. Configuration

- [ ] Set every variable in `.env.example` (locally) and the corresponding Cloud Run env vars / Secret Manager bindings (deploy). Only Gemini 3.x models are supported.
- [ ] **Model sizing:** template node defaults are heuristic for 9 of 12 pipeline nodes — only the intake classifiers are measured. Read `src/agents/CLAUDE.md` before tuning, and apply install-specific tuning via `NODE_PROFILE_OVERRIDES` (per-node profiles) or `MODEL_ID_OVERRIDES` (shared tier/version ID map); legacy `GEMINI_MODEL` / `GEMINI_FLASH_MODEL` do not select serving models. See README “Serving model overrides”. The `.env.example` comment documents the measured clarification downsize as a candidate override; re-measure on a domain corpus before adopting it install-wide.
- [ ] **Fast path:** leave `FAST_PATH_ENABLED=false` until your knowledge store is synced (the path is inert without it). Then pilot with `FAST_PATH_REQUIRE_SUPERVISOR=true` and review eligibility/latency results before allowing supervisor skips.
- [ ] Review cost and safety limits for your warehouse: `COST_GATE_MAX_BYTES`, `QUERY_TIMEOUT_MS`, `MAX_RESULT_ROWS`, `RATE_LIMIT_PER_HOUR`.
- [ ] Configure project-level GCP cost guardrails: a Cloud Console **Billing Budget** (covers Cloud Run, Firestore, GCS, and BigQuery), BigQuery custom daily query quotas (`QueryUsagePerDay` / `QueryUsagePerUserPerDay`), and a Cloud Monitoring alert on `bigquery.googleapis.com/query/scanned_bytes_billed` (unless already managed by your warehouse repo, e.g., `dbt-core-gcloud-template`'s `infra/90-monitoring.sh`).

## 6. Deploy and verify

- [ ] Deploy per README **"Deployment"** (automatic via GitHub secrets, or the manual local-docker path).
- [ ] Verify `GET /health` returns 200 and `GET /health/doctor` reports every dependency green.
- [ ] Run `npm run setup:check` — for implementation readiness expect **zero errors and zero warnings** (the template tolerates warnings; you should not).
- [ ] Run the Slack smoke tests end to end, including a clarification flow and an escalation.

## 7. The acceptance run

This is the governing tranche — do it before adding a second domain or any new product behavior (trajectory-governance, Active Tranche A).

- [ ] Replace `benchmarks/corpus.json` with implementation questions that exercise your chosen domain, including expected reference/teaching IDs where retrieval matters.
- [ ] Run the real benchmark against live services and save the JSON under `benchmarks/results/`.
- [ ] Run `scripts/benchmark-analyze.ts` and review the `*-referencecard-acceptance.md` report.
- [ ] Record the dated decision in `docs/trajectory-governance.md`: `ACCEPTED` unlocks exactly one additional domain; `NEEDS_REVISION` scopes a repair tranche for the failing evidence category.

## 8. Known template gaps you inherit

None currently — the template's Operational Trust tranche closed the previously listed gaps; check `docs/trajectory-governance.md` for any newer ones.

## Updating from the template

Read [CHANGELOG.md](CHANGELOG.md), especially **Action required** notes, before
updating or deploying (see its versioning note). Work in a clean checkout on an
update branch and back up implementation-owned content. Add the remote once,
with `--no-tags` so later fetches never pull template tags into your own tags:

```bash
git remote add --no-tags template https://github.com/domainmethods/annalytics.git
```

Then, for each update, fetch template tags into a separate namespace outside
`refs/tags/` (so they cannot collide with your own `vX.Y.Z` tags or be
published by `git push --tags`) and merge:

```bash
git fetch --no-tags template 'refs/tags/*:refs/template-tags/*'
git switch -c update/template-release
# Replace vX.Y.Z with an actual published template release tag.
git merge refs/template-tags/vX.Y.Z
```

Release tags start at `v0.1.0`; use the newest tag listed in the changelog. For a repository created with
GitHub **Use this template** (or another copy without shared history), use
`git merge --allow-unrelated-histories refs/template-tags/vX.Y.Z` for the first
sync instead.
With unrelated histories there is no merge base: files changed upstream can
produce add/add conflicts even when you never edited them locally, including
runtime code, tests, infrastructure, and deploy configuration. Files the
template deleted after your snapshot are not removed for you and produce no
conflict; after the merge, compare `git ls-tree -r --name-only refs/template-tags/vX.Y.Z`
against your tree and delete obsolete template files deliberately.

In this merge direction (template into your implementation), resolve each file
you never customized with the template version:

```bash
git checkout --theirs <path>
git add <path>
```

For customized files, compare both versions against your original template
snapshot and reconcile your customizations with upstream changes. Do not take
`--theirs` wholesale for those files. After resolving all conflicts:

```bash
git add <resolved-paths>
git commit
```

The commit completes the merge; do this before running checks or deploying.
To abandon a bad merge and return to the pre-merge state, run `git merge --abort`.
These steps also apply if you track `template/main` instead of a release tag
(release tags are recommended): refresh it with `git fetch template main`, then
run `git merge --allow-unrelated-histories template/main`.

Subsequent updates use an ordinary merge. Forks/clones with shared history use
an ordinary merge from the start.

Resolve conflicts deliberately: implementations typically own `dbt/`, knowledge
and ReferenceCards (`references/`, `teachings/`, or a local `knowledge/`), `.env`,
`NODE_PROFILE_OVERRIDES` in local/deployment configuration, and governance and
benchmark evidence. Ignored files may need a separate backup; do not publish
client material or secrets back to the public template. Keep local evidence while
incorporating upstream governance rules. Review the merged diff, run the README
checks and implementation acceptance/smoke tests, then deploy per the README.
