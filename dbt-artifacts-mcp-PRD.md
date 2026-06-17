# Product Requirements Document: dbt-artifacts-mcp

## 1. Title, Description, Status

**dbt-artifacts-mcp** — An open-source MCP server that turns *hosted* dbt Core artifacts (`manifest.json`, `catalog.json`, and friends) into a read-only semantic-grounding layer for AI agents, with **zero live dependencies**: no dbt Cloud account, no warehouse credentials, no Python dbt install, no local project directory.

- **Document status:** DRAFT — for review
- **Version:** 0.1
- **Date:** `<YYYY-MM-DD>`
- **Owner:** `<owner / maintainer>`
- **Strategic classification:** OSS loss-leader / embeddable grounding component. **This is explicitly not positioned as a standalone product or business** (see §10–§11). It exists to (a) be the cleanest artifacts-only dbt MCP server available, and (b) externalize the semantic-grounding layer for an analytics product the maintainer already controls (e.g. the Anna Lytics Slack bot, which today COPYs `manifest.json`/`catalog.json` into its container image).

---

## 2. Problem Statement & Motivation

**Who hurts.** Analytics engineers, data engineers, and AI/agent builders who run **self-managed dbt Core** and want an LLM agent (Claude Desktop, Claude Code, Cursor, an internal Slack bot, a CI job) to *understand their dbt project* — which models exist, what columns mean, what physical types they have, how models depend on each other, what tests guard them, when sources last loaded — **without granting the agent a dbt Cloud account or live warehouse credentials**.

**Why this is unmet today.** The official `dbt-labs/dbt-mcp` server (Apache-2.0, ~577 stars, ~90K PyPI downloads/month, actively maintained — `v1.20.4`, 2026-06-15) deliberately splits along a commercial line:

- Its entire **rich-metadata surface** — Semantic Layer, Discovery API (`get_all_models`, `get_model_details`, `get_lineage`, `get_model_health`, …), SQL execution, and Admin API — **hard-requires a paid dbt Platform/Cloud account**. `validate_dbt_platform_settings()` in `src/dbt_mcp/config/settings.py` raises a startup `ValueError` if any of those groups is enabled without `DBT_HOST` + (`DBT_PROD_ENV_ID` | `DBT_PROJECT_IDS`) + `DBT_TOKEN`. Worse, those groups are **enabled by default**, so a naive `uvx dbt-mcp` with only `DBT_PROJECT_DIR`/`DBT_PATH` *fails to start* until the operator explicitly sets `DISABLE_SEMANTIC_LAYER`/`DISABLE_DISCOVERY`/`DISABLE_ADMIN_API` (the exact friction behind issue [#408](https://github.com/dbt-labs/dbt-mcp/issues/408)).
- What remains for **pure dbt Core** is thin: the dbt CLI tools, Codegen, **two** local-manifest readers (`get_lineage_dev`, `get_node_details_dev`), and Product Docs. The CLI/Codegen tools require a **live local dbt install** (a resolvable `DBT_PATH` executable plus a real `DBT_PROJECT_DIR` containing `dbt_project.yml`). The two `_dev` readers only open a **local** `DBT_PROJECT_DIR/target/manifest.json` — never an arbitrary hosted location — and **never parse `catalog.json` for column types** (the catalog parser exists in the codebase but is dead in the live fetch path; column types there come only from the paid Discovery API).

**Why now.**
1. **The market is large, durable, and Cloud-free.** Only ~5,000 of ~50,000 weekly-active dbt teams pay for Cloud (Feb 2025); the overwhelming majority run free dbt Core. dbt Core v2.0 remains **Apache-2.0** on the Fusion engine with an explicit post-merger (Fivetran, closed 2026-06-01) commitment to maintain Core "indefinitely." The audience is not being sunset.
2. **MCP is a safe platform bet.** It is now neutrally governed under the Linux Foundation's **Agentic AI Foundation** (donated 2025-12-09), with Anthropic, OpenAI, Google, Microsoft, and AWS all as Platinum members; ~97M+ monthly SDK downloads (real registries are higher); 10,000+ servers. Single-vendor capture risk has effectively been retired.
3. **The hosting pattern already exists.** Teams routinely have CI (GitHub Actions/GitLab) publish artifacts to object storage (S3/GCS/Azure Blob/R2) or a static dbt docs site, primarily to power Slim CI and `--state` deferral. "Read hosted artifacts" is therefore a *realistic* ingestion model, not a hypothetical one.

**The honest constraint.** This is and will remain a **point-in-time snapshot** layer: no live query execution, no fresh rows, no metric *computation*. `catalog.json`/`sources.json` are only as current as the last `dbt docs generate`/`dbt source freshness` run. That constraint defines the product's scope and its trust requirements (§8), not a defect to be papered over.

---

## 3. Market Context & Competitive Landscape

### 3.1 The official server (`dbt-labs/dbt-mcp`) — feature-gating, cited

| Fact | Detail | Source |
|---|---|---|
| First-party, mature, fast | ~70 tools across 8 groups; ~577 stars / 124 forks; ~weekly releases; `v1.20.4` (2026-06-15); pushed daily | `github.com/dbt-labs/dbt-mcp` |
| Rich metadata is Cloud-gated **at startup** | Semantic Layer, Discovery API, SQL, Admin API require `DBT_HOST` + (`DBT_PROD_ENV_ID`\|`DBT_PROJECT_IDS`) + `DBT_TOKEN`; `validate_dbt_platform_settings()` raises `ValueError`. These groups are **enabled by default** | `src/dbt_mcp/config/settings.py` |
| Discovery API itself is paid-Cloud-only | Requires a dbt Cloud paid plan (Starter/Enterprise/Enterprise+); unavailable to self-managed Core | `docs.getdbt.com/docs/dbt-cloud-apis/discovery-api` |
| Core-only residue is thin | dbt CLI, Codegen (default-disabled), `get_lineage_dev` + `get_node_details_dev` (local manifest), Product Docs | `settings.py`, README |
| No hosted-artifact ingestion | Only file path reads **local** `DBT_PROJECT_DIR/target/manifest.json`; **never parses `catalog.json` for column types** (parser is dead code in live path) | source review at HEAD `6622aa4` |
| CLI/Codegen need a live install | `DBT_PROJECT_DIR` (validated to exist) + resolvable `DBT_PATH` executable; shells out via `subprocess` | `settings.py` |
| Strategic direction | Post-Coalesce-2025: remote MCP, dbt Agents, Semantic Layer steered into the **paid** platform; dbt's own blog admits "the local dbt MCP server isn't easy to deploy or host for multi-tenanted workloads" — and built the *paid remote server* in response rather than hardening the free local one | `getdbt.com/blog`, `docs.getdbt.com/blog/building-the-remote-dbt-mcp-server` |

### 3.2 Existing community tools

*Live status verified 2026-06-16 via GitHub commit cadence and release history (not the misleading `archived` flag — none are formally archived; "abandoned" below means no commits in ~12 months).*

| Tool | License / traction | What it does | Gap vs. our wedge |
|---|---|---|---|
| `mattijsdp/dbt-docs-mcp` | MIT, ~23★, single `v0.0.1` (Apr 2025), **abandoned** (no commits since mid-2025) | The other true artifacts-only server: reads `manifest.json` + `catalog.json`; node/column/compiled-SQL search, attributes, predecessors/successors, **real column-level lineage** (sqlglot) | Hours-long offline column-lineage prebuild (`create_manifest_cl.py`); **parses catalog types but never surfaces them** (buried in an internal sqlglot schema-map — no tool returns a `type`/`data_type` field, so an agent can't get physical types); no hosted-source ingestion; no staleness handling; abandoned |
| `us-all/dbt-mcp-server` | MIT, **active** (`v1.0.5`, 14 releases, shipping this week), TypeScript/npm | **Closest new overlap.** Local artifacts-only dbt metadata (models/tests/sources/exposures/macros/runs) **plus a warehouse-connected DQ layer** (BigQuery/Postgres). **Already surfaces `catalog.json` column physical types** (`dataType: catalogEntry?.columns?.[c.name]?.type ?? c.data_type`). Ships HTTP+Bearer+`/health`, 4 MCP-Prompt triage playbooks, a `search-tools` meta-tool | **Local-filesystem only** (`path.join`+`existsSync`, no URL-scheme handling) — no hosted/remote ingestion, so it cannot serve multi-tenant / CI / air-gapped agents; its DQ layer needs live warehouse creds (not zero-dependency) |
| `NiclasOlofsson/dbt-core-mcp` | MIT, ~13★, **active** (`v1.7.1`, Mar 2026) | "Bridge execution" — reads local manifest, then runs the user's **live** dbt install (`dbt show`, run/test/build) incl. live column-lineage via compile | **Not** artifacts-only; hard-requires dbt Core ≥1.9 + adapter + project dir + live warehouse |
| `Astoriel/dbt-doctor` | MIT, ~146★ (most-starred), **maintenance** | Coverage audit, profiling, drift detection, doc/test generation | Needs `dbt compile` first **and a live warehouse connection**; local-project-dir only; solves a different (quality/governance) problem |
| `arcmesh-labs/dbt-mcp` | No license, 0★, 2 commits (May 2026), **demo/student** | Reads local `manifest`/`run_results`; `run_model` executes dbt live | Not artifacts-only (runs dbt); local-only; never parses `catalog.json`; not production-grade |
| Long tail (~10 servers) | Mostly low-star | CLI wrappers, warehouse-connected profiling, Cloud/Semantic-Layer querying | None serve offline, zero-dependency, hosted-artifacts |

### 3.3 The wedge

**Offline ingestion of HOSTED dbt artifacts into agent-grounding MCP tools with zero live dependencies.** This is genuinely uncovered: the official server's rich metadata is paid-Cloud-gated at startup and its only file path is local-`DBT_PROJECT_DIR`-bound (and ignores `catalog.json` column types); the one abandoned artifacts-only competitor requires an hours-long prebuild; and the one *actively-shipping* artifacts-only server (`us-all/dbt-mcp-server`, which **does** surface catalog types) is strictly **local-filesystem** — it has no hosted/remote loader at all. Every existing server reads artifacts from a local path; **none ingest from S3/GCS/Azure/R2/HTTP.** The specific high-value, defensible slice is **column-physical-type-aware model/column docs + node lineage/impact analysis served from artifacts a CI job already publishes**, fit for multi-tenant/hosted agents, CI/PR impact analysis, and air-gapped environments — exactly the multi-tenant hostability gap dbt Labs flagged and is monetizing via its paid remote server.

**Honest caveat carried throughout this PRD:** the prior pure-artifacts servers failed to clear ~25 stars after the official free option shipped, and the most-starred community server (`dbt-doctor`, 146★) wins on a *warehouse-connected* quality story, not on artifacts grounding. The one fast-moving new entrant (`us-all`) likewise bundles a warehouse DQ layer rather than betting on artifacts alone. Read together: **standalone demand for a pure artifacts-grounding server is thin; traction accrues to servers that add a live/quality dimension.** That is why §10–§11 treat this as a loss-leader beneath Anna Lytics, not a product — and why the hosted-ingestion wedge, not catalog types, is the thing worth being first on.

---

## 4. Goals & Non-Goals

### Goals
- **G1.** Serve a genuinely useful **read-only semantic layer** to MCP clients from **hosted dbt Core artifacts** with no live dbt, no warehouse creds, no dbt Cloud.
- **G2.** Be **radically simpler to install** than the official server: "point at your artifacts (local path *or* hosted URL), done." No default-enabled tool group should ever throw at startup for lack of a Cloud token.
- **G3.** Expose `catalog.json` **column physical types** joined to `manifest.json` descriptions — the concrete capability the *official* server lacks. (No longer unique in the community: `us-all/dbt-mcp-server` shipped this in 2026; treat as parity to match, and lead instead on serving it **from hosted artifacts with zero warehouse dependency** — G4.)
- **G4.** Support a **pluggable hosted artifact source** (local path, S3, GCS, Azure Blob, Cloudflare R2, HTTP/static-docs URL) with per-store auth.
- **G5.** Be **honest about staleness**: surface each artifact's `generated_at` and warn when stale. Non-negotiable for NL-to-SQL grounding.
- **G6.** Be **safe and embeddable**: read-only by construction; support both `stdio` and **streamable HTTP** transports; treat transport/auth security as first-class.
- **G7.** **Out-engineer the stalled incumbent**: no hours-long preprocessing; defensive multi-schema-version parsing; quality and docs as differentiators.
- **G8.** Prove the loss-leader thesis by wiring it into a product the maintainer controls (Anna Lytics) as the externalized semantic layer.

### Non-Goals (respecting the synthesis)
- **NG1.** **No live query execution or row sampling.** Out of the artifacts-only contract; leave to the host product's own warehouse path.
- **NG2.** **No metric *computation* / Semantic Layer querying.** We serve metric *definitions* from `semantic_manifest.json`; computing values needs a live MetricFlow engine (dbt Labs' paid territory).
- **NG3.** **No standalone managed-SaaS and no open-core feature gating.** No moat (dbt Labs owns the format and can match parity in a release); open-core gating invites Redis/Elastic/HashiCorp-style backlash.
- **NG4.** **No hours-long column-level-lineage prebuild in v1.** Node-level lineage is sufficient for grounding; column-level lineage is deferred (§7.4, §13).
- **NG5.** **No shelling out to the dbt CLI** and **no requirement for a local project directory**. If we depend on a `dbt` binary we have lost our entire differentiation.
- **NG6.** **No write-back / project mutation** (Codegen-style YAML generation), and no data-quality profiling (that needs a warehouse — see `dbt-doctor`).

---

## 5. Target Users, Personas & Use Cases

### Persona A — Analytics Engineer "Priya" (dbt Core, no Cloud)
Runs dbt Core against BigQuery; CI publishes `manifest.json`/`catalog.json` to GCS. Wants Claude Code / Cursor to answer project questions while she develops, without standing up dbt Cloud.

Example prompts:
- *"Which models reference `stg_orders`, and what breaks downstream if I change its `order_status` column?"* → `impact_analysis`
- *"What's the physical type and description of `customer_id` in `dim_customers`?"* → `get_column_docs` (manifest description + **catalog type**)
- *"List the models that have no tests."* → `list_tests` + project-health query

### Persona B — AI/Agent Builder "Marcus" (multi-tenant, hosted)
Builds an internal "chat with our data models" agent serving multiple teams. Hit exactly the pain dbt flagged: the official local server "isn't easy to deploy or host for multi-tenanted workloads," and he refuses to wire dbt Cloud tokens into a shared agent.

Example prompts (issued by his agent on a user's behalf):
- *"Find models related to revenue recognition."* → `search_models`
- *"Give me the full schema and lineage of `fct_revenue` so I can ground a SQL draft."* → `get_model` + `get_model_lineage`
- *"What metrics are defined, and which model backs `net_revenue`?"* → `find_metrics`

### Persona C — Data Platform / CI Engineer "Dana" (governance on PRs)
Wants PR-time impact analysis with **no warehouse and no creds** — read the artifacts the PR's CI already produced.

Example prompts (in a CI agent):
- *"This PR modifies `int_payments`. Enumerate the downstream exposures and marts at risk."* → `impact_analysis` + `list_exposures`
- *"Did the last build of these models pass, and were any tests failing?"* → `get_run_status`

### Persona D — Host-Product Maintainer "the Anna Lytics team" (loss-leader adjacency)
Wants to replace the ad-hoc "COPY manifest/catalog into the image" pattern with a clean, reusable MCP boundary the analytics bot consumes for table/column/metric grounding — keeping live SQL validation/execution in the bot's existing warehouse path.

Example prompts (the bot grounding an NL question):
- *"User asked 'sessions by traffic source last 30 days' — what models/columns ground this?"* → `search_models` + `get_column_docs`
- *"Is the catalog backing this answer stale?"* → every tool returns `generated_at` + a staleness flag.

---

## 6. Solution Overview & Architecture

### 6.1 High-level

```
        ┌─────────────────────────────────────────────────────────┐
        │                   dbt-artifacts-mcp                       │
        │                                                           │
 MCP    │  ┌────────────┐   ┌──────────────┐   ┌────────────────┐  │
 client │  │ Transport  │   │  Tool /      │   │  Graph + Index │  │
 (stdio │◄─┤ stdio +    │◄──┤  Resource    │◄──┤  (parent/child │  │
 / HTTP)│  │ streamable │   │  layer       │   │  maps, search) │  │
        │  │ HTTP)      │   └──────────────┘   └───────┬────────┘  │
        │  └────────────┘                              │           │
        │                       ┌──────────────────────┴────────┐  │
        │                       │  Artifact Cache (in-mem +      │  │
        │                       │  optional disk), generated_at  │  │
        │                       │  + schema-version metadata     │  │
        │                       └──────────────┬─────────────────┘  │
        │           ┌──────────────────────────┴───────────────┐    │
        │           │  Pluggable Artifact Source (loaders)      │    │
        │           │  local | s3 | gcs | azure | r2 | http     │    │
        │           └──────────────────────────┬───────────────┘    │
        └──────────────────────────────────────┼────────────────────┘
                                                │ (read-only fetch)
                  manifest.json / catalog.json / run_results.json /
                  sources.json / semantic_manifest.json  (HOSTED)
```

### 6.2 Artifact ingestion — where artifacts are hosted

A **source URI** drives a loader. Supported in v1:

| Scheme | Backend | Auth |
|---|---|---|
| `file://` / bare path | Local filesystem (incl. image-baked artifacts) | filesystem perms |
| `s3://bucket/prefix` | AWS S3 | IAM role / access keys / presigned URL |
| `gs://bucket/prefix` | Google Cloud Storage | service-account JSON / ADC |
| `az://container/prefix` | Azure Blob | SAS token / managed identity |
| `r2://bucket/prefix` | Cloudflare R2 | S3-compatible keys |
| `https://…` | HTTP/static-docs site or presigned URL | bearer / basic / none |

Each artifact is addressed independently (e.g. a `manifest.json` may live at one key and `catalog.json` at another). The operator may point at **immutable/timestamped/commit-SHA keys** (enables longitudinal `run_results` later) or an overwritten `latest` key.

> **Static-docs caveat surfaced in docs:** when `dbt docs generate --static` inlines artifacts into `static_index.html`, the separate JSON files may not be independently fetchable; v1 supports the **un-inlined** layout (separate `manifest.json`/`catalog.json`) and documents this limitation.

### 6.3 Parsing

Parsers for the five static artifacts, each keyed by `unique_id` so they join:

- **`manifest.json`** (richest; required): `nodes`, `sources`, `metrics`, `exposures`, `groups`, `macros`, `docs`, plus precomputed `parent_map` / `child_map` / `group_map`. Per node: `name`, `unique_id`, `package_name`, paths, `depends_on.{nodes,macros}`, `columns` (+descriptions), `description`, `tags`, `config` (materialization/schema), compiled/raw SQL. **Powers most tools.** Present from nearly any project-parsing command.
- **`catalog.json`** (the differentiator; optional): per-resource `metadata` (table/view, db, schema, owner, comment), `columns` (name, **type**, comment, ordinal index), and `stats` (rows/bytes, adapter-dependent). Produced by `dbt docs generate` (queries the warehouse at generate-time). **Degrade gracefully**: if absent or `--empty-catalog`, run manifest-only and flag "no physical types available."
- **`run_results.json`** (optional): per-node `status`, `execution_time`, `timing`, `adapter_response` (rows, bytes), `failures`, `message`. Powers run-status tools. One invocation per file.
- **`sources.json`** (optional): source freshness — `max_loaded_at`, `snapshotted_at`, `criteria`, `status`. Powers `source_freshness`. **Reports historical freshness at generate-time, never re-checks on read.**
- **`semantic_manifest.json`** (optional): MetricFlow `semantic_models` (entities/measures/dimensions), `metrics` (`type`, `type_params`, `filter`), `saved_queries`. Powers `find_metrics` — **definitions only, not computed values.**

### 6.4 Caching & refresh

- **Load-on-start + lazy refresh.** Parsed artifacts cached in memory; optional disk cache for large manifests.
- **Refresh modes** (config): `manual` (refresh via an admin tool/resource), `interval` (poll the source every N seconds — checks ETag/Last-Modified before re-download), `on-miss-ttl` (re-fetch when cache age exceeds TTL). Hosted artifacts refresh only as fast as the producing CI job; the server inherits that cadence and **says so**.
- **`generated_at` propagation.** Every parsed artifact's `metadata.generated_at` is retained and attached to every tool/resource response. A `staleness_threshold` (config, default 24h) flips a `stale: true` flag + human-readable warning.

### 6.5 MCP transport

- **`stdio`** — default for local single-user clients (Claude Desktop/Code, Cursor).
- **Streamable HTTP** — required for any hosted/multi-tenant deployment; **preferred over raw stdio in untrusted contexts** given MCP's dominant incident class (stdio-transport RCE, tool poisoning, prompt injection). Supports OAuth bearer auth and per-request scoping. SDK pinned to the **2025-11-25** spec revision.

### 6.6 Auth for remote artifact stores
Credentials are resolved from the environment/ambient provider chain per backend (IAM role, ADC, managed identity) — never embedded in tool inputs. Presigned URLs are supported for least-privilege HTTP access. Bucket encryption-at-rest is the documented baseline recommendation (artifacts leak schema/lineage detail).

### 6.7 Handling artifact schema-version skew
dbt artifact schemas version **independently** (manifest currently `v12`, catalog `v1`, run_results `v6`, sources `v3`) and have historically bumped on dbt minors. The parser MUST:
1. Read `metadata.dbt_schema_version` (the `schemas.getdbt.com/...` URL) and branch on it.
2. **Tolerate unknown/extra fields** (treat as optional) — never hard-fail on a field it doesn't recognize.
3. Support a **range** (target manifest `v10`–`v12+`); v12 has been stable across Core v1.8–v1.12, so the near-term burden is modest, but `v20` exists for the Fusion engine and the loader must not crash on it (parse what it can, flag the rest).
4. Emit a structured warning (not a crash) on a version it cannot fully map, returning best-effort partial metadata.

---

## 7. MCP Tool & Resource Surface (v1)

All tools are **read-only**. Every response envelope includes `source_generated_at`, `artifact_schema_version`, and `stale` (bool).

### 7.1 Discovery & search

**`search_models`** — find models/sources/seeds/snapshots by name, description, tag, or schema.
- *Inputs:* `query: string`, `resource_types?: string[]` (default `["model"]`), `tags?: string[]`, `limit?: int=20`
- *Outputs:* `[{ unique_id, name, resource_type, schema, materialization, description_snippet, tags, score }]`

**`search_sources`** — same, scoped to `sources`.

### 7.2 Model / column detail

**`get_model`** — full node detail.
- *Inputs:* `model: string` (name or `unique_id`)
- *Outputs:* `{ unique_id, name, package, schema, database, materialization, description, tags, columns: [{name, description, type?, comment?, index?}], depends_on, raw_sql?, compiled_sql?, config }`
- `type`/`comment` come from `catalog.json` when present; flagged `null` + `catalog_available:false` otherwise.

**`get_column_docs`** — **the differentiator.** Manifest descriptions joined with catalog physical types/stats for one model.
- *Inputs:* `model: string`, `column?: string`
- *Outputs:* `[{ column, description, data_type, comment, ordinal, source: "manifest"|"catalog"|"both" }]` + `catalog_available`, `catalog_generated_at`

### 7.3 Lineage & impact

**`get_model_lineage`** — direct (via `parent_map`/`child_map`) and transitive (via `depends_on` traversal) **node-level** lineage.
- *Inputs:* `model: string`, `direction: "upstream"|"downstream"|"both"`, `depth?: int` (default unlimited)
- *Outputs:* `{ upstream: [unique_id…], downstream: [unique_id…], edges: [[from,to]…] }`

**`impact_analysis`** — downstream closure for change-impact.
- *Inputs:* `node: string`, `include_exposures?: bool=true`
- *Outputs:* `{ affected_models: [...], affected_exposures: [...], affected_tests: [...], total_count }`

### 7.4 Tests, runs, sources, metrics, exposures

**`list_tests`** — tests, optionally scoped to a model/column.
- *Inputs:* `model?: string`, `column?: string`
- *Outputs:* `[{ test_unique_id, test_name, attached_node, column_name?, test_type }]`

**`get_run_status`** — last-run health from `run_results.json` (requires that artifact).
- *Inputs:* `model?: string`, `status_filter?: ("pass"|"fail"|"error"|"skipped")[]`
- *Outputs:* `[{ unique_id, status, execution_time, rows_affected?, failures?, message? }]` + `run_results_generated_at`. Returns a clear "no run_results artifact configured" notice if absent.

**`source_freshness`** — historical freshness from `sources.json` (requires that artifact).
- *Inputs:* `source?: string`
- *Outputs:* `[{ source_unique_id, status, max_loaded_at, snapshotted_at, criteria }]` + an explicit **"freshness as of `<generated_at>`, not live"** caveat in every response.

**`find_metrics`** — MetricFlow metric **definitions** from `semantic_manifest.json` (requires that artifact).
- *Inputs:* `query?: string`, `metric?: string`
- *Outputs:* `[{ name, description, type, type_params, backing_semantic_model, measures, dimensions, filter? }]` + a **"definitions only — values require a live Semantic Layer"** note.

**`list_exposures`** — downstream BI/consumers from `manifest.json`.
- *Inputs:* `model?: string`
- *Outputs:* `[{ name, type, owner, depends_on, url?, description }]`

### 7.5 Project-health helpers (cheap, manifest-only)
**`find_models_missing_docs`**, **`find_models_missing_tests`** — lint-style queries over the manifest. Useful to Persona A/C; zero extra artifacts required.

### 7.6 Resources
- `dbt://project/metadata` — `generated_at`, dbt version, schema versions, artifact availability matrix, staleness flags.
- `dbt://model/{unique_id}` — same payload as `get_model`, exposed as a resource for clients that prefer resource reads.
- `dbt://manifest/summary` — counts by resource type, packages, materializations.

### 7.7 Explicitly deferred / out of v1
- **Live query execution / row sampling** — out of the artifacts-only contract permanently (NG1).
- **Semantic Layer metric *querying*/computation** — needs a live engine (NG2).
- **Column-level lineage** — the incumbent's hours-long prebuild is a poison pill; node-level lineage suffices for grounding. Deferred to a later phase, and only if it can be made cheap/incremental (§13).
- **Longitudinal run/test trend analysis** — needs retaining a series of `run_results.json`; deferred until a real demand signal appears.
- **Write-back / Codegen / profiling / drift** — non-goals (NG6).

---

## 8. Functional & Non-Functional Requirements

### Functional
- **F1.** Boot successfully with **only** an artifact source configured — never throw for a missing Cloud token (the anti-pattern of the official server).
- **F2.** Operate fully with `manifest.json` alone; each additional artifact (`catalog`, `run_results`, `sources`, `semantic_manifest`) **independently enriches** the surface and its absence degrades **gracefully** with explicit availability flags.
- **F3.** Every tool/resource response carries `source_generated_at`, `artifact_schema_version`, `stale`.
- **F4.** Refresh artifacts per configured mode without a restart.

### Non-Functional

**Performance (large manifests).**
- **NF1.** Parse a large manifest (≥5,000 nodes, ≥100 MB) once at startup; build `parent_map`/`child_map` adjacency and a name/description search index in memory. Target: cold parse < 10 s for 100 MB; tool calls (search, get_model, lineage at unbounded depth) p95 < 150 ms warm.
- **NF2.** Stream-parse / lazily index to keep RSS bounded; optional on-disk parsed cache so multi-tenant HTTP workers don't each re-parse.

**Security.**
- **NF3.** **Read-only by construction** — no code path can mutate artifacts, the warehouse, or the dbt project. No `subprocess`/`dbt` invocation exists in the codebase.
- **NF4.** **Transport/auth security is first-class:** prefer streamable HTTP + OAuth in untrusted/multi-tenant contexts; scope tokens minimally; never expose ambient authority; sanitize tool descriptions/inputs (tool-poisoning defense). Pin the MCP SDK and track the dated spec (2025-11-25).
- **NF5.** **Secrets:** store credentials resolved from the ambient provider chain; never accept secrets as tool inputs; never echo store URIs/credentials in responses or logs.
- **NF6.** Optional **path/prefix allowlist** so a hosted instance can be constrained to a tenant's artifact prefix.

**Observability.**
- **NF7.** Structured logs (load events, refresh, parse warnings, schema-version skew) with no secret leakage.
- **NF8.** Metrics: per-tool latency/error counts, cache hit ratio, last-refresh timestamp, current artifact `generated_at` + staleness. A `/health` (liveness) and `/ready` (artifacts loaded & parseable) endpoint for the HTTP transport.

---

## 9. Configuration & Deployment

### 9.1 Config file (`dbt-artifacts-mcp.yaml`) — or equivalent env vars
```yaml
transport: stdio            # stdio | http
http:
  host: 0.0.0.0
  port: 8080
  auth: oauth               # none | bearer | oauth  (oauth/bearer required for non-loopback)
artifacts:
  manifest:  gs://my-bucket/dbt/latest/manifest.json
  catalog:   gs://my-bucket/dbt/latest/catalog.json
  run_results: gs://my-bucket/dbt/latest/run_results.json   # optional
  sources:   gs://my-bucket/dbt/latest/sources.json          # optional
  semantic_manifest: gs://my-bucket/dbt/latest/semantic_manifest.json  # optional
refresh:
  mode: interval            # manual | interval | on-miss-ttl
  interval_seconds: 900
staleness_threshold_seconds: 86400
schema_versions:
  manifest_min: v10
  manifest_max: v12         # tolerate unknown > max with a warning
```
Every key has an `DBT_ARTIFACTS_MCP_*` env-var equivalent.

### 9.2 Install / run
```bash
# Python (uvx / pipx) — zero-install run
uvx dbt-artifacts-mcp --config dbt-artifacts-mcp.yaml
pipx run dbt-artifacts-mcp --manifest ./target/manifest.json --catalog ./target/catalog.json
```
> Distribution channels: PyPI, the official MCP Registry, glama.ai, and the dbt Community Slack. (`npx` is offered only if a TS port ships later; the reference implementation is Python to match the artifact ecosystem.)

### 9.3 Example client configs

**Claude Desktop** (`claude_desktop_config.json`), local artifacts:
```json
{
  "mcpServers": {
    "dbt-artifacts": {
      "command": "uvx",
      "args": ["dbt-artifacts-mcp",
               "--manifest", "/path/target/manifest.json",
               "--catalog", "/path/target/catalog.json"]
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`), hosted artifacts on GCS:
```json
{
  "mcpServers": {
    "dbt-artifacts": {
      "command": "uvx",
      "args": ["dbt-artifacts-mcp", "--config", "./dbt-artifacts-mcp.yaml"],
      "env": { "GOOGLE_APPLICATION_CREDENTIALS": "/path/sa.json" }
    }
  }
}
```

**Hosted (multi-tenant) — streamable HTTP**, behind OAuth, in a container:
```bash
docker run -p 8080:8080 \
  -e DBT_ARTIFACTS_MCP_TRANSPORT=http \
  -e DBT_ARTIFACTS_MCP_HTTP_AUTH=oauth \
  -e DBT_ARTIFACTS_MCP_ARTIFACTS_MANIFEST=s3://bucket/dbt/latest/manifest.json \
  ghcr.io/<org>/dbt-artifacts-mcp:latest
```

### 9.4 Anna Lytics integration (loss-leader proof)
Anna Lytics points its grounding layer at the server (HTTP transport, in-cluster), replacing the COPY-into-image pattern. Live SQL validation/execution stays in the bot's existing BigQuery path; the server supplies table/column/metric grounding only.

---

## 10. Differentiation & Defensibility / Moat

**Honest differentiators (verified capability gaps, not marketing):**
1. **True zero-dependency operation** — no dbt Cloud, no warehouse creds, no Python dbt install, no project dir, no proprietary dbt-lsp. The official server *structurally cannot* match this: its platform groups are enabled by default and throw without a token; its CLI tools require a resolvable `dbt` binary + project dir.
2. **Consumes `catalog.json` for column physical types** — a concrete gap against the *official* server (its catalog parser is dead code in the live path; types come only from the paid Discovery API). ⚠️ **No longer unique among the community:** `us-all/dbt-mcp-server` (active, TS) now surfaces catalog types too — so frame this as *table stakes we must match*, not a moat. The surviving type-related edge is doing it **from hosted artifacts with zero warehouse dependency**, which `us-all` (local-only + warehouse DQ layer) does not.
3. **Pluggable HOSTED artifact source** with per-store auth — the official `_dev` tools read only a local `DBT_PROJECT_DIR`.
4. **Radically simpler install** ("point at JSON files") vs. the official dual-flavor, multi-env-var, credit-gated experience.
5. **No hours-long preprocessing** (vs. `dbt-docs-mcp`); explicit `generated_at` staleness warnings; defensive multi-schema-version parsing — trust features in an ecosystem where only ~13% of servers are high-trust.

**Defensibility — stated plainly:** There is **no durable standalone moat.** dbt Labs owns the artifact format, already ships the NL-to-SQL upsell, and could add a free local/hosted static-artifact discovery toolset (including catalog column types) in a single release and subsume the niche with its distribution. The only real defensibility is **adjacency**: being the open ingestion layer beneath a product the maintainer controls (Anna Lytics), plus first-mover quality/trust in a niche the incumbent is *strategically declining* to serve with its free server (and monetizing via its paid remote server). Treat the moat as the product above the server, not the server itself.

---

## 11. Open-Source & Sustainability Model

- **License recommendation: Apache-2.0** (or MIT). Permissive maximizes adoption and signals "this is a credibility/lead-gen asset, not a rent-seeking product." **Do not** use open-core gating or a source-available license — verified to invite backlash (MongoDB/Elastic/HashiCorp/Redis precedent) and to provide no moat against the format owner anyway.
- **Governance:** single-maintainer-led with a public roadmap and contribution guide; small enough scope that a BDFL model is appropriate. Publish a security policy (`SECURITY.md`) given MCP's incident profile.
- **Monetization options considered & recommendation:**
  - *Standalone managed-SaaS* — **rejected**: dbt Labs can match parity in a release; hyperscalers (BigQuery Comments-to-SQL, Snowflake Cortex) are commoditizing NL-to-SQL natively.
  - *Open-core feature gating* — **rejected**: backlash + no moat.
  - *Per-call MCP billing* — only viable if hosted with value the free local server lacks (multi-tenant hosting, governance); weak on its own.
  - **Recommended: pure-OSS + (a) loss-leader for a product the maintainer controls** (the Anna Lytics hosted analytics bot, a governance/CI tool, or consulting), **and (b) optional GitHub Sponsors / Open Collective** as a credibility signal. The server's *job* is adoption and lead-gen, not direct revenue.

---

## 12. Success Metrics / KPIs & Adoption Funnel

**Adoption funnel:** Awareness (dbt Community Slack ~50K, MCP Registry, glama.ai, GitHub) → Install (PyPI downloads, `uvx`/`pipx` runs) → Activation (server boots with a real artifact source) → Retention (recurring use; multi-artifact configs) → **Adjacency conversion** (installs that lead to the host product / consulting).

| KPI | 6-month target | 12-month target |
|---|---|---|
| GitHub stars | > 100 (out-traction both stalled incumbents) | > 300 |
| PyPI installs (de-noised of CI) | meaningful weekly active configs | growing |
| External adopters citing it (issues/PRs/blogs) | ≥ 5 | ≥ 20 |
| `catalog.json`-enabled configs (the differentiator in use) | > 40% of configs | > 50% |
| MCP Registry trust score | ≥ 70/100 (top ~13%) | maintain |
| Anna Lytics fully grounded via the server | shipped | maintained |
| Median client-reported grounding latency (p95 tool call) | < 150 ms warm | < 150 ms |

**Leading quality signals:** zero default-throw startup bugs; schema-skew parse-warning rate (should be low, never crash); staleness flag correctly raised in tests.

---

## 13. Milestones & Phased Roadmap

**Riskiest assumptions to validate FIRST (cheapest probes):**
- **RA1 — the gap stays open.** Watch the `dbt-mcp` changelog + issue #408 for a free static-artifact discovery toolset that reads `catalog.json` from an arbitrary location. *Probe weekly; this is a kill trigger (§14).*
- **RA2 — the loss-leader adjacency is real.** Confirm Anna Lytics can consume the server cleanly before public investment. *Validate in v0.*
- **RA3 — schema skew is manageable.** Parse real-world manifests across dbt v1.8–v1.12 (+ a Fusion `v20` sample) and confirm defensive parsing holds. *Validate in v0.*

**v0 — MVP (internal, ~2–4 weeks)**
- `manifest.json` + `catalog.json` from **local path + one hosted backend** (GCS, given Annalytics' GCP footprint).
- Tools: `search_models`, `get_model`, `get_column_docs`, `get_model_lineage`, `impact_analysis`, `list_tests`.
- `stdio` transport. `generated_at` + staleness flags. Defensive multi-schema-version parsing.
- **Wire into Anna Lytics** as the externalized semantic layer (proves RA2). *Gate: works end-to-end internally.*

**v1 — Public OSS release**
- Add `run_results.json`, `sources.json`, `semantic_manifest.json` → `get_run_status`, `source_freshness`, `find_metrics`, `list_exposures`, project-health helpers.
- Pluggable sources: S3, Azure, R2, HTTP/static-docs (un-inlined). Per-store auth.
- **Streamable HTTP** transport + OAuth; `/health`/`/ready`; structured logs/metrics.
- Apache-2.0, docs, `SECURITY.md`, PyPI + MCP Registry + glama.ai listing; Community Slack launch.

**Later (demand-gated, not pre-built)**
- Cheap/incremental **column-level lineage** (only if it avoids the hours-long prebuild).
- **Longitudinal run/test trends** (retain a series of `run_results.json`).
- Optional TS port (`npx`) if client demand warrants.

---

## 14. Risks, Mitigations & Kill Criteria

| Risk | Mitigation |
|---|---|
| **Incumbent parity in one release** (dbt Labs adds free static-artifact discovery + catalog types) — *dominant strategic risk* | Don't over-invest; keep scope tight; lead on install simplicity, hosted sources, and staleness/trust; rely on adjacency, not the server, for value. Monitor changelog/issue #408. |
| **Thin standalone demand** (two priors stalled < 25 stars) | Treat as loss-leader from day one; success is measured by adjacency conversion, not stars. |
| **No defensible standalone monetization** (verified) | Do not attempt SaaS/open-core; monetize the product above (Anna Lytics / governance / consulting). |
| **Honest-value ceiling** (point-in-time snapshot; no live rows/metrics; catalog/sources only as fresh as last generate) | Surface `generated_at` + staleness on every response; never imply live data; document the contract prominently. |
| **Schema-version skew maintenance** (manifest versions, historical minor bumps; Fusion `v20`) | Defensive parsing: branch on `dbt_schema_version`, tolerate unknown fields, support a range, warn-not-crash. Mitigated by v12 stability across four minors. |
| **MCP security surface** (stdio RCE, tool poisoning, prompt injection; >30% of servers vulnerable) | Read-only by construction; prefer HTTP+OAuth in untrusted contexts; sanitize tool descriptions/inputs; scope tokens; pin SDK to 2025-11-25 spec; publish `SECURITY.md`. |
| **MCP spec churn** (quarterly-ish, ≥1 backward-compat change) | Version-pin SDK; budget periodic upgrades; track dated revisions. |

**Kill criteria (stop / pivot to internal-only):**
1. dbt Labs ships a free local/hosted static-artifact discovery toolset reading `catalog.json` column types from an arbitrary location → wedge collapses; pivot to pure-Annalytics-internal use.
2. After a genuine distribution push, the server fails to materially out-traction the stalled incumbents (sub-50 stars / a handful of external adopters over 6–12 months) → keep only as an internal dependency, not a maintained public product.
3. The maintainer cannot point the server at a product they control (no hosted bot, no governance/CI tool, no consulting funnel) → no adjacency to monetize; a maintained public OSS server is unpaid labor → **don't start.**
4. Warehouse-native NL-to-SQL + the official Cloud path so commoditize the analytics-bot layer that the host product loses its reason to exist → the loss-leader has nothing left to lead to.
5. Artifact-schema or MCP-spec churn upkeep exceeds strategic value (e.g. manifest resumes per-minor bumps **and** adoption is low).

**Key open questions:**
- Reference language — Python (matches artifact ecosystem) is the default; is a TS port ever worth it for `npx`-first client audiences?
- Refresh model for hosted artifacts — is interval-poll-with-ETag sufficient, or do we need a webhook/push from CI?
- Do we need a tenant-prefix allowlist in v1 for Persona B, or defer to v1.x?
- Is there real demand for `--static` (inlined) docs-site parsing, or is the un-inlined layout enough?

---

## 15. Appendix: dbt Artifact → Capability Mapping

| Artifact | Produced by | Key fields consumed | Tools / resources powered | Required? | Staleness behavior |
|---|---|---|---|---|---|
| **manifest.json** | nearly any project-parsing command (`parse`/`compile`/`run`/`build`/`docs generate`) | `nodes`, `sources`, `metrics`, `exposures`, `groups`, `macros`, `docs`, `parent_map`, `child_map`, `depends_on`, per-node `columns`+descriptions, `config`, raw/compiled SQL | `search_models`, `search_sources`, `get_model`, `get_column_docs` (descriptions), `get_model_lineage`, `impact_analysis`, `list_tests`, `list_exposures`, `find_models_missing_docs/tests`, all resources | **Yes** | `generated_at`; relatively fresh (regenerated often) |
| **catalog.json** | `dbt docs generate` (queries warehouse; skippable via `--empty-catalog`) | per-resource `metadata`, `columns` (name, **type**, comment, index), `stats` | enriches `get_model` & `get_column_docs` with **physical types/stats** (the differentiator) | No (graceful degrade) | most staleness-prone; only as fresh as last `docs generate` |
| **run_results.json** | `build`/`run`/`test`/`compile`/`docs generate` etc. | `results[]`: `unique_id`, `status`, `execution_time`, `timing`, `adapter_response`, `failures`, `message` | `get_run_status` (+ failed-models / failing-tests filters) | No | single invocation snapshot; `generated_at` surfaced |
| **sources.json** | `dbt source freshness` | per-source `status`, `max_loaded_at`, `snapshotted_at`, `criteria` | `source_freshness` | No | **historical** freshness only; never re-checked on read — explicit caveat in responses |
| **semantic_manifest.json** | project parse (MetricFlow) | `semantic_models`, `metrics` (`type`, `type_params`, `filter`), `saved_queries` | `find_metrics` | No | definitions only; values require a live Semantic Layer (out of scope) |

> **Cross-cutting:** every tool joins artifacts by `unique_id`, and every response carries `source_generated_at`, `artifact_schema_version`, and `stale`. Column-level lineage is **not** in any artifact and is **deferred** (it requires a separate SQL-parsing pass — the incumbent's hours-long prebuild — and node-level lineage is sufficient for grounding).