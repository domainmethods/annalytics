# Phase 2b — Learning Infrastructure Design

**Date**: 2026-02-15
**Status**: Approved
**Features**: #21 INFORMATION_SCHEMA Fallback, #20 dbt Run Status Queries, #22 Feedback-to-Teachings Promotion

---

## Overview

Three features that close gaps in the bot's knowledge layer: handling non-dbt tables, answering dbt operational questions, and turning escalation resolutions into durable teachings. Together they make the bot more robust (21), more useful for data team workflows (20), and self-improving (22).

---

## Feature 21: INFORMATION_SCHEMA Fallback

### Problem

When the LLM references a table that exists in BigQuery but has no dbt metadata (raw source tables, ad-hoc tables), the pipeline has zero schema context for it. The LLM guesses column names and types, which often fails at dry run.

### Solution

Query `INFORMATION_SCHEMA.COLUMN_FIELD_PATHS` to build a minimal `TableContext` for non-dbt tables. Cache results in Firestore with 24h TTL.

### When It Triggers

During schema retrieval in the pipeline, if a user's question references a table pattern that doesn't match any parsed dbt model (e.g., "query the raw_events table"), the pipeline calls `getSchemaFallback(projectId, dataset, table)` to build a `TableContext` from INFORMATION_SCHEMA.

### Detection Approach

Proactive detection during schema retrieval: if the user mentions a table name that fuzzy-matches a BigQuery table but has no dbt entry, fetch its schema via INFORMATION_SCHEMA before SQL generation. This gives the LLM real column info on the first attempt rather than failing at dry run and retrying.

### Data Flow

```
User question mentions "raw_events"
→ Schema retrieval: no dbt match for "raw_events"
→ Check Firestore cache: miss
→ Query INFORMATION_SCHEMA.COLUMN_FIELD_PATHS
→ Build minimal TableContext (no description, no lineage, tagged 'no-dbt-metadata')
→ Cache in Firestore (24h TTL)
→ Include in prompt with quality warning: "⚠️ minimal documentation"
```

### Implementation

**New file**: `src/dbt/informationSchemaFallback.ts`

```typescript
async function getSchemaFallback(
  projectId: string,
  datasetId: string,
  tableId: string
): Promise<TableContext>
```

Queries `INFORMATION_SCHEMA.COLUMN_FIELD_PATHS` for the given table. Returns a `TableContext` with:
- `name`: `{datasetId}.{tableId}`
- `description`: empty (no business description available)
- `materialization`: `'unknown'`
- `columns`: from INFORMATION_SCHEMA (name, data_type, description if present)
- `dependsOn`: empty
- `tags`: `['no-dbt-metadata']`

**New file**: `src/state/informationSchemaCache.ts`

Firestore collection `information_schema_cache`, keyed by `{dataset}.{table}`. Each document:

```typescript
interface InformationSchemaCacheEntry {
  tableContext: TableContext;
  cachedAt: Date;
  expiresAt: Date;  // 24h TTL
}
```

**Modification**: `src/pipeline.ts` — schema retrieval step calls fallback when a referenced table has no dbt match.

### Limitations

- No business descriptions, no lineage, no quality metadata
- The prompt explicitly tells the LLM to be more cautious with these tables
- Prompt includes quality warning: `"Table: raw_events (⚠️ minimal documentation — no dbt metadata)"`

---

## Feature 20: dbt Run Status Queries

### Problem

Users ask "when was dim_customers last built?" or "did the last dbt run succeed?" and the bot tries to generate SQL for it, which fails because run metadata isn't in BigQuery.

### Solution

Three pieces: an ingestion endpoint, a Firestore collection, and a dbt status handler that bypasses the SQL pipeline entirely.

### Ingestion Endpoint

A POST endpoint (`/api/dbt-run-results`) on the Express receiver accepts `run_results.json` from a GitHub Actions post-build step.

**Authentication**: Shared secret (`DBT_WEBHOOK_SECRET` env var) passed as a Bearer token.

**Processing**: Parse each model result and write to a `dbt_run_history` Firestore collection, keyed by `{runId}_{modelName}`.

```typescript
interface DbtRunHistoryEntry {
  model: string;
  status: 'success' | 'error' | 'skipped';
  executionTime: number;
  runId: string;
  runStartedAt: Date;
  errorMessage?: string;
}
```

Documents get a 90-day Firestore TTL for automatic cleanup.

### Pipeline Routing

The clarification agent already classifies `route: 'dbt_status'` but the pipeline ignores it. Add a branch after clarification: if `route === 'dbt_status'`, skip SQL generation and go to the dbt status handler.

### dbt Status Handler

Query Firestore for relevant run history documents, pass the raw data + user question to Flash LLM to format a conversational answer. Handles varied phrasings:

- "When was dim_customers last built?" → query latest doc for that model
- "Did the last dbt run succeed?" → query all docs for the most recent runId
- "Which models failed recently?" → query docs with `status: 'error'` in last 7 days
- "How long does fct_orders take to build?" → aggregate execution times

### Data Flow

```
GitHub Actions: dbt build completes
→ POST /api/dbt-run-results with run_results.json body + Bearer token
→ Parse + write per-model docs to Firestore dbt_run_history

User: "when was dim_customers last built?"
→ Clarification agent: route = 'dbt_status'
→ Pipeline branches to dbt status handler
→ Firestore query: dbt_run_history where model == 'dim_customers',
  order by runStartedAt desc, limit 5
→ Flash LLM formats: "dim_customers was last built 2 hours ago
  (success, took 45s)"
```

### Implementation

**New files**:
- `src/dbt/runHistory.ts` — Firestore CRUD for `dbt_run_history` collection
- `src/agents/dbtStatusAgent.ts` — Flash LLM call to format run history into a conversational answer
- `src/handlers/dbtRunIngestion.ts` — Express POST endpoint for `run_results.json`

**Modifications**:
- `src/pipeline.ts` — branch on `clarification.route === 'dbt_status'` after clarification step
- `src/app.ts` — register the `/api/dbt-run-results` endpoint on the Express receiver
- `src/config.ts` — add `DBT_WEBHOOK_SECRET` to config

### Firestore Index

```json
{
  "collectionGroup": "dbt_run_history",
  "fields": [
    { "fieldPath": "model", "order": "ASCENDING" },
    { "fieldPath": "runStartedAt", "order": "DESCENDING" }
  ]
}
```

This index already exists in the design doc's `firestore.indexes.json` specification.

---

## Feature 22: Feedback-to-Teachings Promotion (80/20 Scope)

### Problem

The escalation flow (Phase 2) generates high-quality corrected SQL from human experts, but that knowledge dies in Firestore. It should flow back into the teaching system so the bot learns permanently.

### Solution

When a human resolves an escalation, automatically generate a teaching candidate and store it in Firestore. A CLI tool (`npx anna-lytics promote`) lets the data team review candidates, approve/reject them, and write approved ones to YAML files. The existing CI sync pipeline picks them up.

### Teaching Candidate Generation

When `escalationResponse.ts` processes a human reply and resumes the pipeline, it also calls Flash LLM with structured output to extract a teaching:

- **Input**: original user question, escalation context (what the bot was stuck on), human's free-text response, the final SQL that worked
- **Output**: `TeachingCandidate` — question_patterns, reasoning, sanctioned_sql (if applicable), models_referenced, tags
- **Cost**: ~$0.002 per escalation (Flash, small context)

The candidate is written to a `teaching_candidates` Firestore collection with status `pending`.

```typescript
interface TeachingCandidate {
  candidateId: string;
  escalationId: string;
  status: 'pending' | 'approved' | 'rejected';
  // Extracted teaching content
  questionPatterns: string[];
  reasoning: string;
  sanctionedSql: string | null;
  modelsReferenced: string[];
  tags: string[];
  // Source context
  originalQuestion: string;
  humanResponse: string;
  generatedAt: Date;
}
```

### CLI Review Tool

`scripts/promote-teachings.ts` — interactive CLI that:

1. Lists all `pending` candidates with a one-line summary
2. For each, shows the full candidate (question patterns, SQL, reasoning, source context)
3. Data team member picks: **approve**, **skip**, or **reject**
4. Approved candidates are written as YAML to `teachings/{id}.yml`
5. Status updated to `approved` or `rejected` in Firestore

After running the CLI, the data team commits the new YAML files and pushes. The existing `sync-teachings.yml` GitHub Action handles the rest (upload to File Search, update Firestore summaries).

### Data Flow

```
Human resolves escalation in Slack
→ escalationResponse.ts resumes pipeline
→ generateTeachingCandidate() calls Flash LLM
→ Write to Firestore teaching_candidates (status: pending)

Data team runs: npx anna-lytics promote
→ CLI lists pending candidates
→ Team approves/rejects each
→ Approved → written to teachings/{id}.yml
→ git add + commit + push
→ CI syncs to File Search store
```

### Implementation

**New files**:
- `src/teachings/candidateGenerator.ts` — Flash LLM extraction of teaching from escalation context
- `src/state/teachingCandidates.ts` — Firestore CRUD for `teaching_candidates` collection
- `scripts/promote-teachings.ts` — CLI review tool

**Modifications**:
- `src/handlers/escalationResponse.ts` — trigger candidate generation after escalation resolution

### What's Explicitly NOT in Scope

- No Slack approval UI
- No auto-PR to GitHub
- No thumbs-up-based promotion (escalation-sourced only)
- No promotion criteria algorithms
- No weekly digest notifications

These can be layered on in Phase 3 if needed.

---

## New Firestore Collections Summary

| Collection | Key | Purpose | TTL |
|---|---|---|---|
| `information_schema_cache` | `{dataset}.{table}` | Cached I_S column metadata | 24 hours |
| `dbt_run_history` | `{runId}_{model}` | Per-model dbt run results | 90 days |
| `teaching_candidates` | `candidateId` | Pending teaching promotions | None (manual cleanup) |

## New Files Summary

| File | Feature | Purpose |
|---|---|---|
| `src/dbt/informationSchemaFallback.ts` | #21 | Query I_S, build minimal TableContext |
| `src/state/informationSchemaCache.ts` | #21 | Firestore cache for I_S results |
| `src/dbt/runHistory.ts` | #20 | Firestore CRUD for dbt run history |
| `src/agents/dbtStatusAgent.ts` | #20 | Flash LLM to format run status answers |
| `src/handlers/dbtRunIngestion.ts` | #20 | POST endpoint for run_results.json |
| `src/teachings/candidateGenerator.ts` | #22 | Flash LLM teaching extraction |
| `src/state/teachingCandidates.ts` | #22 | Firestore CRUD for candidates |
| `scripts/promote-teachings.ts` | #22 | CLI review tool |

## Modified Files Summary

| File | Features | Change |
|---|---|---|
| `src/pipeline.ts` | #21, #20 | Schema fallback call; dbt_status route branch |
| `src/app.ts` | #20 | Register /api/dbt-run-results endpoint |
| `src/config.ts` | #20 | Add DBT_WEBHOOK_SECRET |
| `src/handlers/escalationResponse.ts` | #22 | Trigger candidate generation |
