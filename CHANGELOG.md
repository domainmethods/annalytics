# Changelog

Notable template changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow Semantic Versioning. This first baseline summarizes merged history;
1.0.0 matches package.json and is proposed, not yet tagged or released.

Maintainers: at release time, move Unreleased entries into a dated version section
(or finalize the proposed baseline), leave an empty Unreleased section, and align
package.json and package-lock.json if the version changes. After merging to main,
tag that main commit `vX.Y.Z` and create a GitHub release from its changelog section.

## [Unreleased]

### Added

- Template update instructions and this release history.

## [1.0.0] - Proposed

### Fixed

- **Action required — SELECT-only validation (#106):** L3 rejects any dry run whose
  `job.metadata.statistics.query.statementType` is missing, unknown, or not `SELECT`.
  Verify your BigQuery dry runs return that field before deploying; local AST
  parsing remains advisory.
- **Action required — dbt webhook (#99, #100):** authenticated JSON now reaches
  ingestion (5 MiB limit; malformed bodies return 400, oversized bodies 413).
  Model `success` and test `pass` persist as success rather than skipped. Verify
  your CI webhook and resulting dbt status records after updating.
- **Action required — benchmark acceptance (#103, #105):** only expected and
  observed LOW clarification suspensions with null SQL, no validation attempts,
  and no crash receive validation/supervisor exemptions. Table selection scores
  warehouse relations with query scope rather than incidental names; unsupported
  SQL earns no table credit and may be unscorable. Re-run implementation acceptance
  with the corrected instruments before relying on prior verdicts.

- BigQuery execution timeout now reaches job configuration (#96); unsafe INT64
  values retain exact decimal strings, including nested results (#104). Consumers
  of query results should allow strings for integers outside JavaScript safe range.
- Terraform Secret Manager automatic-replication syntax now parses (#97).

### Changed

- **Action required — WhatsApp admission (#101):** when enabled,
  `WHATSAPP_ALLOWED_WA_IDS` must contain at least one trimmed tester ID or startup
  fails. All inbound message/action paths require exact sender membership.
  Configure the allowlist before enabling; the prototype remains default-off.
- **Action required — deployment (#98, #102):** deploy commands update template
  env/secrets while preserving other service entries. Audit retained settings;
  remove obsolete entries explicitly. `--no-cpu-throttling` keeps CPU available
  after Slack acknowledgment and enables instance-based billing, including CPU
  and memory charges during idle time. Review billing before deploying.
- **Action required — startup sampling (#107):** nonempty cached samples up to
  seven days old skip scans. Stale/missing samples refresh in the background,
  sequentially per instance, capped at the lower of 100 MiB and
  `COST_GATE_MAX_BYTES` per job. Review the cap and sample freshness for your
  tables; rejected refreshes preserve previous samples, and separate cold
  instances may each attempt a refresh.

### Added

- Initial template baseline: Slack question-to-SQL pipeline, layered validation,
  human escalation, dbt metadata, ReferenceCards and knowledge sync, benchmark
  tools, and the gated WhatsApp prototype (merged history through #107).

PR references: https://github.com/domainmethods/annalytics/pulls?q=is%3Apr+is%3Amerged
