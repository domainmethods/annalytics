# Market Viability Assessment — OSS dbt Core MCP Server (artifacts-only)

**Date:** 2026-06-16
**Question:** Is it worth building an open-source MCP server for dbt **Core** users (who don't use dbt Cloud, which has its own MCP server), assuming dbt artifacts from a dbt Core run are hosted somewhere the server can read?
**Method:** 6 parallel web-research streams → 9 load-bearing claims selected → each claim adversarially fact-checked by two independent verifiers (one tasked to refute, one to confirm with primary sources) → synthesis. 27 agents, ~480 tool calls.

---

## Verdict: CONDITIONALLY VIABLE — score 58/100, high confidence

**The wedge is real and survived source-code-level verification. The standalone business is not.**

Build it **only** as a pure-OSS loss-leader / embeddable grounding layer for a product you already control (Anna Lytics). Do **not** build it as a standalone product or business — there is no defensible monetization moat.

---

## Why the wedge is real (all verified `supported`, both lenses)

1. **The official `dbt-labs/dbt-mcp` server gates its rich metadata behind a paid dbt Cloud account — enforced in code, at startup.** Its Semantic Layer, Discovery API, SQL execution, and Admin API tool groups all require `DBT_HOST` + (`DBT_PROD_ENV_ID`|`DBT_PROJECT_IDS`) + `DBT_TOKEN`; `validate_dbt_platform_settings()` in `settings.py` throws a `ValueError` if they're enabled without those creds — **and they're enabled by default**, so a naive `uvx dbt-mcp` on pure Core *fails to start*. (Apache-2.0, ~577★, ~weekly releases, v1.20.4 on 2026-06-15.)
2. **The official server has no hosted-artifact mode.** Its only file path reads a **local** `DBT_PROJECT_DIR/target/manifest.json` via two thin `_dev` tools; it **never parses `catalog.json` for column types** (the catalog parser is dead code in the live path — column types come only from the paid Discovery API). Its CLI/Codegen tools require a live local dbt install + project directory.
3. **A complete read-only semantic layer is derivable offline** from five static JSON files (`manifest`, `catalog`, `run_results`, `sources`, `semantic_manifest`) with zero warehouse or Cloud access — model/source search, column docs *with physical types*, node lineage + impact analysis, test inventory, run status, source freshness, metric definitions.
4. **The market is large and durable.** Only ~5,000 of ~50,000 weekly-active dbt teams pay for Cloud (~80% run free Core). dbt Core v2.0 stays Apache-2.0 with an explicit post-Fivetran-merger OSS commitment.
5. **MCP is a safe platform bet.** Donated to the Linux Foundation's Agentic AI Foundation (Dec 2025); Anthropic, OpenAI, Google, Microsoft, AWS all Platinum members; ~97M monthly SDK downloads; 10,000+ servers; no credible competing standard at the tool-connection layer.
6. **dbt Labs is steering AI-over-metadata into its *paid* platform** (remote MCP, dbt Agents, Semantic Layer, column lineage) and explicitly admits the free local server "isn't easy to deploy or host for multi-tenanted workloads" — a gap it is choosing not to close for free.

**The specific defensible slice:** column-physical-type-aware model/column docs + node lineage/impact analysis, served from artifacts a CI job already publishes to object storage (S3/GCS/Azure/R2) — fit for multi-tenant/hosted agents, CI/PR impact analysis, and air-gapped environments. **Zero live dependencies:** no dbt Cloud, no warehouse creds, no Python dbt install, no local project dir, no proprietary dbt-lsp.

---

## Why it's only *conditionally* viable (also all verified `supported`)

1. **No defensible standalone monetization.** dbt Labs owns the artifact format and the natural NL-to-SQL upsell, and could ship parity in a single release. Open-core gating invites Redis/Elastic/HashiCorp-style backlash. Managed-SaaS can be matched. Hyperscalers (BigQuery Comments-to-SQL, Snowflake Cortex) are commoditizing NL-to-SQL natively.
2. **Thin standalone demand signal.** The two prior independent artifacts-only/local dbt MCP servers both stalled: `mattijsdp/dbt-docs-mcp` (~23★, single v0.0.1, abandoned, needs an hours-long column-lineage prebuild) and `NiclasOlofsson/dbt-core-mcp` (~13★, bridges to a *live* dbt install, not artifacts-only). Low traction after the official free server shipped.
3. **Honest value ceiling.** Artifacts are point-in-time snapshots — no live rows, no metric computation; `catalog.json`/`sources.json` are only as fresh as the last `dbt docs generate` / `source freshness`. For NL-to-SQL grounding this is a *trust hazard* unless staleness is surfaced on every response.
4. **Maintenance tax.** Artifact schemas version independently (manifest ~v12) and have bumped on dbt minors historically; parsing must be defensive. MCP spec churns (~quarterly).

---

## Recommendation

**Build it — narrowly, as infrastructure for Anna Lytics, released as pure OSS (Apache-2.0).** This is exactly your existing pattern (manifest/catalog COPY'd into the image as a static semantic layer), promoted to a clean, reusable MCP boundary. Benefits: externalizes Anna Lytics' grounding layer, doubles as a credibility/lead-gen asset, and occupies a niche dbt Labs is strategically declining to serve for free — all without betting on standalone revenue that the evidence says isn't there.

**Measure success by adjacency conversion, not GitHub stars.**

### Kill criteria (stop, or keep internal-only)
- dbt Labs ships a free static-artifact discovery toolset that reads `catalog.json` column types from an arbitrary location (watch the `dbt-mcp` changelog + issue #408) → wedge collapses.
- After a real distribution push it fails to out-traction the stalled incumbents (sub-50★ / a handful of external adopters over 6–12 months) → keep as an internal Anna Lytics dependency only.
- You can't point it at a product you control → no adjacency to monetize → don't start a *public* maintained project.

---

## Sources & full detail
See the companion PRD (`dbt-artifacts-mcp-PRD.md`) for the cited competitive table, tool surface, architecture, and roadmap. Raw research artifacts (per-claim verdicts, findings summaries, synthesis JSON) are in `/tmp/dbt-mcp-research/`.
