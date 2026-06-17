# Anna Lytics ⇄ dbt-artifacts-mcp — Integration Design

**Date:** 2026-06-16
**Status:** Internal strategy (not part of the public PRD)
**Companion docs:** `dbt-artifacts-mcp-PRD.md`, `dbt-core-mcp-viability-assessment.md`
**Method:** Judge-panel of 3 candidate architectures (each designed against the actual code), synthesized to one recommendation, then adversarially verified by two lenses (codebase-realism + over-engineering). Both returned **sound-with-caveats**; the caveats are folded in below.

---

## TL;DR

**Recommended: Option C (phased), led by a conformance fixture suite — not a code extraction.**

- **Now (cheap, governance-free):** publish a **golden-fixture conformance suite** — sample `manifest.json`/`catalog.json` → expected parsed output — and run it in *both* Anna Lytics' vitest suite and the OSS server's CI. This *is* the shared artifact. It satisfies the PRD's RA2 ("confirm Anna Lytics can consume the server cleanly") **without moving the just-repaired parser** (`src/dbt/parser.ts`, commit `fa88783`, the only `ACCEPTED` benchmark slice on record).
- **Optional, later:** extract `parseDbtArtifacts` into a shared TS module if a second consumer ever justifies it. Treat this as a **benchmark-gated change** (re-run the `ACCEPTED` slice), not a free refactor.
- **Do NOT now:** make Anna Lytics an MCP *client* (Option B). It would build a retrieval + network primitive to solve a prompt-budget problem the bot doesn't have on one small/medium dbt project. Textbook over-engineering.
- **Keep:** the COPY-into-image whole-schema-dump posture. It only fails at boot; it can never "miss" a relevant table.
- **Phase 2 (deferred, scale-triggered):** when the SQL-gen prompt outgrows the model's input budget (or the bot must serve >1 dbt project), insert **one** retrieval call at `pipeline.ts:235`, preferring a **plain internal RPC** over an MCP client. Dogfooding the MCP transport is a separate, explicit choice that requires a `docs/trajectory-governance.md` update because it's net-new product work.

---

## Why this, grounded in the code

Three verified facts drive the recommendation:

1. **Anna Lytics has no retrieval step and is not a tool-calling agent.** `pipeline.ts:235` is `let pipelineTables = [...tables]` — the *whole* table set. `sqlGenerator.ts:38-47` joins every model's `sampleDDL` into one prompt, and generation uses Gemini **structured output** (`responseJsonSchema`), not a function-calling loop. So MCP-client integration isn't a drop-in; it's an architecture change to a retrieval model.

2. **The language reality forbids literal "shared in-process code."** The PRD commits the reference server to **Python** (§9.2; TS/`npx` is deferred in §13). Anna Lytics is **TypeScript**, and its only zero-latency consumption path is an in-process import — which must be a TS module. You cannot share one code artifact across both. What you *can* share is a **parsing contract** pinned by fixtures.

3. **What's worth sharing is small and subtle.** The high-value logic is exactly the fiddly part: BigQuery `UPPERCASE→lowercase` catalog normalization (`parser.ts:42-46`), the undocumented-catalog-column union (`parser.ts:60-73`, the `fa88783` fix), the 64-column cap, and the `manifest`/`catalog` `unique_id` join. The PRD's defensive schema-version parsing (§6.7) is a genuine robustness upgrade over the bot's bare `JSON.parse` (`app.ts:57-58`).

---

## What stays in Anna Lytics (an artifacts-only product cannot supply these)

| Component | Where | Why it stays |
|---|---|---|
| `generateDDL` / `sampleDDL` | `src/dbt/parser.ts` | It's **LLM prompt-presentation** (`types.ts:7`: "CREATE TABLE DDL for prompt injection"), not a dbt-artifact property. The PRD's `get_model` (§7.2) returns structured columns, never a DDL string. Putting it in the shared module would leak prompt concerns into a general library *and* mismatch the server's output. |
| `TableContext` / `ColumnContext` | `src/dbt/types.ts` | Kept bot-owned so the **16** files importing it don't move. The shared module would export an artifact-neutral `ModelMeta`; a thin bot-local mapper bridges it. |
| INFORMATION_SCHEMA fallback | `src/dbt/informationSchemaFallback.ts`, `pipeline.ts:234-257` | Queries BigQuery for **non-dbt** tables — not in artifacts (PRD NG1). Keeps its `generateDDL` import. |
| Live sample rows | `src/dbt/sampleRows.ts`, `sampleRowCache.ts` | Fetched live from BigQuery at startup; artifacts have no rows (NG1). |
| Teaching / ReferenceCard layer | `src/teachings`, `src/references` (Gemini File Search) | Analyst guidance, not in artifacts. |
| `dbt_run_history` (dbt_status route) | Firestore, CI-webhook fed | Already a non-artifacts data path; migrating to the server's `get_run_status` is a separate optional decision. |
| Whole-schema-dump assembly + no-retrieval posture | `sqlGenerator.ts:38-47` | Unchanged in Phase 1; only Phase 2 inserts retrieval. |
| L1–L4 validation + BigQuery execution | `src/validation`, `src/execution` | Explicitly out of the artifacts-only contract (NG1, PRD §9.4). |

---

## What moves to the OSS product

- The **parsing contract** as a versioned TS module **+ the conformance fixture suite** (the real shared artifact): the manifest-`model` iteration, catalog normalization, undocumented-column union, 64-col cap, `unique_id` join.
- **Defensive multi-schema-version parsing** (PRD §6.7): branch on `metadata.dbt_schema_version`, tolerate unknown/extra fields, support v10–v12+, don't crash on Fusion `v20`, warn-not-crash. (Hardens the bot, which today does naive `JSON.parse` with no version guard.)
- The **artifact source loader** abstraction (local in v0; `gs://` etc. later, PRD §6.2) — server-only; the bot keeps its image-baked `readFileSync` in Phase 1.
- The **MCP tool surface** + staleness envelope + streamable-HTTP/OAuth transport — server-only; the bot never exercises these until (deferred) Phase 2.

---

## Phased plan

**Phase 0 — decision gate (real gate, not a rubber stamp).** Confirm RA2 can be satisfied by **fixtures alone**. If yes (it is), the parser extraction is optional. If the extraction is pursued, note in `docs/trajectory-governance.md` that it touches the benchmark-gated `fa88783` path and must re-run the `ACCEPTED` slice in the same change set.

**Phase 1 (now) — fixtures-first, zero behavior change.**
1. Build the **golden-fixture conformance suite** (sample `manifest`/`catalog` → expected `ModelMeta`), run in the bot's vitest suite; hand the same fixtures to the Python server's CI as the parity spec.
2. *(Optional)* Extract `parse(manifest, catalog) → ModelMeta[]` into a shared TS module (lift `parser.ts:27-90` **minus** `generateDDL`). Add a bot-local `modelMetaToTableContext` mapper that synthesizes `sampleDDL` via the existing `generateDDL`. Repoint `app.ts:5,59` and `teachings/validation.ts:57-59`. `readFileSync`, `getTables()`, `TableContext`, `generateDDL`, INFORMATION_SCHEMA fallback all unchanged. `npm run typecheck` + `npm test` green; **re-run the `ACCEPTED` benchmark slice**.
3. *(Server side, OSS)* Implement the Python reference server wrapping the same contract; verify against the shared fixtures. **The bot does not call it** — this proves RA2 at the logic level.

**Phase 2 (DEFERRED — only when the scale trigger fires, after a governance update).** Add `src/dbt/retrievalClient.ts` (plain RPC preferred) with **timeout + circuit-breaker + whole-dump fallback** mirroring the existing `pipeline.ts:254-255` catch. Insert the retrieval call at `pipeline.ts:235` behind a config flag. Treat the server's `stale:true` as a confidence-cap signal (mirroring the existing `fileSearchDegraded` pattern). Ship a **benchmark slice proving retrieval recall ≥ whole-dump accuracy** before flipping the flag.

---

## The scale trigger (measure, don't guess)

Flip from whole-dump to retrieval when **any** of:
- **(a)** p95 SQL-gen prompt tokens (instrument the `schemaSections` join at `sqlGenerator.ts:38-47`) exceed ~50% of the resolved `sqlGenerator` model's input window — note the trigger is **install-relative**, since `nodeProfiles` resolves the model per-install;
- **(b)** the 64-column cap (`parser.ts:21`) starts truncating **marts** (not just wide staging tables) — table-level truncation pressure;
- **(c)** a benchmark slice shows whole-dump SQL accuracy regressing as table **count** grows (model picks wrong tables amid noise);
- **(d, non-size)** the bot must ground against **>1 dbt project/tenant** — baking every project's artifacts into one image becomes untenable, and a shared retrieval server is the natural boundary.

Until at least one is demonstrated on the real corpus, retrieval solves tomorrow's problem at today's latency/coupling cost.

---

## MCP vs. plain API vs. in-process

| Mode | When | Why |
|---|---|---|
| **In-process import** | Phase 1 (now) | Bot uses structured output, not tool-calling; zero per-query benefit to a protocol hop when the whole catalog fits the prompt. MCP is the **external** interface for third-party agents (Personas A/B/C); the bot is Persona D and consumes the **logic**, not the protocol. |
| **Plain internal RPC** | Phase 2 default | Bot needs a retrieval primitive, not JSON-RPC/OAuth/tool-poisoning ergonomics. `searchModels()`/`getModel()` is a far smaller lift than wiring a function-calling loop, and avoids MCP spec-churn coupling (~quarterly) on the hot path. |
| **MCP client** | Phase 2, only if dogfooding the protocol is explicitly chosen | Strongest end-to-end dogfood of the product's headline interface (PRD G6/G8 KPI), but highest cost (polyglot deploy, network hop, SDK pinning). **Requires a governance update** as net-new product work. |

---

## Corrections folded in from adversarial verification

1. **Supervisor is already retrieval-free.** `supervisorAgent.ts` does *not* receive `TableContext` — its input is only the question/SQL/explanation/reasoning/citations. The prompt-budget pressure (and the Phase-2 trigger instrumentation) lives in **`sqlGenerator` alone**; don't instrument the supervisor node.
2. **Preserve the `|| 'UNKNOWN'` edge.** `parser.ts:51` uses `?.type || 'UNKNOWN'` (logical OR), so an empty-string catalog type currently becomes `'UNKNOWN'`. The `ModelMeta→TableContext` mapper must coerce **both `null` and `''`** → `'UNKNOWN'` (don't use `??`), and the fixtures must lock this.
3. **16 importers of `TableContext`, not 11** — the architectural point (keep it bot-owned) stands; the count is corrected for an honest blast-radius estimate. Only **2** files import `parseDbtArtifacts` (`app.ts`, `teachings/validation.ts`).
4. **`/refresh-metadata` is a no-op stub today** (`app.ts:90-93` returns 200 and only logs). If any phase relies on runtime artifact reload, it must first be *implemented* to actually reparse — hot-reload does not exist today.
5. **Guard missing `node.columns`.** `parser.ts:8` types `columns` as required and does `Object.values(node.columns)` with no guard — older/Fusion schema variants could omit it and throw. Fold this into the §6.7 schema-version-tolerance work.
6. **The extraction touches a benchmark-gated module.** `parser.ts`'s union logic was repaired in `fa88783` and underlies the only `ACCEPTED` slice. Mocked unit tests won't catch a grounding regression from the `ModelMeta` round-trip — re-run the slice.

---

## Key open questions

- Who owns the conformance fixtures' source of truth (bot repo, server repo, or a shared package) so neither side can change the contract unilaterally without breaking the other's CI?
- Phase 2 transport: is dogfooding the MCP/HTTP surface (the "fully grounded via the server" KPI) worth the polyglot/latency cost — and does that get an explicit governance update?
- Does Phase 2 migrate the `dbt_status` route to the server's `get_run_status`, or keep the existing Firestore `dbt_run_history` path (not artifacts-derived)?
- In Phase 2, is the image-baked `readFileSync` retained as the whole-dump fallback source, or deleted in favor of the server's `gs://` loader (introducing a cold-start ordering dependency)?
- Will the bot ever ground against >1 dbt project/tenant — the trigger that justifies a shared retrieval server independent of prompt-budget pressure?
