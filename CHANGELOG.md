# Changelog

Notable template changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow Semantic Versioning. Before 1.0, minor versions may contain
breaking configuration changes, always flagged **Action required**. 0.1.0 is the
first tagged baseline and summarizes merged history; its **Action required**
notes apply to copies taken before it. CI/meta-only changes are omitted.
package.json previously read 1.0.0 (an npm default, never a release), so
recorded `packageVersion` metadata may appear to move backwards.

Maintainers: at release time, move Unreleased entries into a dated version
section, leave an empty Unreleased section, and align package.json and
package-lock.json if the version changes. After merging to main,
tag that main commit `vX.Y.Z` and create a GitHub release from its changelog section.

## Unreleased

### Changed

- Answer cards are easier to read (#244). A table answer now leads with a caption that names the top row and runner-up, computed from the table itself and silent whenever the ranking can't be proven (a cut, tied or time-series result). When it is silent the table has no caption: the model-written headline, written before the query runs, is never shown above a table. The button for the view already on screen is hidden, the assumptions line reads as one clause list, and the refine button now reads "Change assumptions". In model-written headlines, including on single-value answers, Slack link or mention syntax now renders literally. 👍/👎, refine, Show SQL and the "Showing X of Y rows" note are unchanged.

### Added

- Behind `ANSWER_SHARES_ENABLED` (default off), a table answer can show a `Share` column, a `Total` row and the leader's share, only when the result is proven to be an additive split of a whole (#244). Anything unproven renders as before; CSV, the Summary text and WhatsApp never get shares.

### Fixed

- After the bot answers an @mention or `/anna` greeting or help request in a channel, an unmentioned follow-up question in that thread now gets an answer instead of being ignored (#53). Greeting replies, mention replies and `/anna` status messages now mark the thread in a new `thread_participation` collection, so this also holds when a run ends in an error without a saved answer. **Action required:** apply the new TTL policy (`thread_participation.expiresAt`) from `infra/firestore.ttls.json`; see README "Firestore TTL Policy".
- A thread follow-up that was classified as a question about an existing answer (explain, refine or investigate) no longer starts a fresh SQL run when its handler fails (#48). The user gets an error with a trace ID instead; only a failed classification still falls back to the standard pipeline.
- Switching a best-effort answer to Table or Summary (including the summary's raw-data fallback and its progress message) keeps the "data team is verifying it" warning, so an unverified result never looks like an ordinary one (#47). This also applies to answers saved before upgrading.
- Single-value answers and discrepancy follow-up summaries now show BigQuery `DATE`/`DATETIME`/`TIMESTAMP` values as text instead of `[object Object]`; an empty single value shows `—` (#34).
- Slack answers, their saved reasoning context and Table/Summary/CSV re-renders now include assumptions made during SQL generation as well as those from clarification, with duplicates removed, matching WhatsApp (#45). Zero-row answers list each assumption once.
- Query results now report the full row count from BigQuery's results response, so a capped result shows its real total and a complete result of exactly the row cap is no longer marked truncated (#38). Short result pages are followed until the row cap is filled, and a page returned before the job finishes is retried instead of read as an empty result.
- 👎 feedback acknowledgements no longer claim "I logged this for review" when nothing was saved (#49). A failed "Other"-note write now says the save failed and how to resubmit; a failed note-form open says so and keeps the reason buttons for a retry; and the no-note record path just says thanks, without claiming anything was saved.
- Two people's free-text 👎 corrections on the same answer no longer overwrite each other (#55). Notes are now stored per reporter (answer trace plus user), still joined to the answer by `traceId`; a retried submission stays one note. Notes saved earlier keep their old ids and stay in the review queue.
- The escalation lifecycle sweep now examines every pending escalation instead of only the first 50 (#54), so an overdue escalation behind 50 still-pending ones gets its reminder and timeout. No new Firestore index is needed. Each sweep acts on at most 100 due escalations, most overdue first, reports the rest as `deferred`, and claims each reminder transactionally before posting so overlapping sweeps cannot double-post.
- The SQL supervisor now receives the user's original wording as well as the clarified question on the Slack and WhatsApp full paths, the benchmark and the node sweep, and on Slack escalation resumes and refinements, so a qualifier dropped during clarification (for example "paid" in "paid orders this month") can be caught in its metric-fidelity check (#44). The routine fast path already did this. Saved answers now store the user's question, and escalation cards and state (including 👎-triggered escalations) show the user's wording instead of the clarified rewrite; answers saved earlier fall back to the clarified question. The wording also survives a clarification round-trip: a refined question that needs clarifying keeps the user's wording in its clarification state, and the reply hands it back to the supervisor; the "still waiting on my question" reminder echoes it too.
- Refining an older answer in a thread now changes that answer, not the newest one (#51). "Wrong assumptions? Click to refine" and the "Not what I asked" feedback reason remember which answer was clicked and by whom, and that user's next reply in the thread, @mention or not, refines it (for 30 minutes). If that choice can't be saved or read, Anna says so and asks you to retry instead of refining the wrong answer. Operators: apply the new `refinement_targets` `expiresAt` TTL policy from `infra/firestore.ttls.json`; no index is needed.
- A BigQuery `STRUCT` with a field named `value` (for example `{value: 4, unit: "hours"}`) no longer loses its other fields in Slack tables, CSV exports and the sample rows shown to the SQL generator (#67). Only the SDK's own `DATE`/`DATETIME`/`TIME`/`TIMESTAMP`/`GEOGRAPHY`/`INT64` wrappers are unwrapped to their text; other records keep every field.
- A result cell containing a bare carriage return no longer splits its row in the exported CSV (#71). The CSV writer now quotes carriage returns as well as commas, double quotes and line feeds, and applies the same quoting to column headers.
- A Slack question no longer fails with a generic error when one table's cached sample rows, or the thread's latest 👎 example, can't be read (#68). Both are optional prompt context: a failed read is logged and treated as missing, the other tables' samples are still used, and the answer is generated as usual, matching WhatsApp.
- An answer past its retention date no longer feeds new questions while it waits for Firestore's TTL deletion (#69). Deciding whether the bot is in a thread, picking the thread's latest answer and picking its latest 👎 example now skip expired answers, as the answer's own buttons already did. Answers saved before `expiresAt` existed now expire `RESPONSE_CONTEXT_RETENTION_DAYS` after they were created, for every reader including the buttons.
- Per-user hourly rate limits admit and count concurrent requests atomically (#31).
- Thread leases now use transactional ownership checks, preventing expired-lease contenders and late cleanup from deleting another request's lock. Existing thread keys and five-minute expiry remain unchanged; no operator action is required.
- Escalation replies and checkmarks now share an atomic resolution claim, and the original thread stays guarded for up to five minutes while a claimed resolution re-runs. Delivery is at most once: interrupted delivery is not retried automatically. If a response is missing, ask a fresh question or contact the data team; resolving records remain available for operator diagnosis until retention expires.
- Bound stored response schema details for Slack and WhatsApp (#84). Failed context writes preserve delivered answers, and Table/Summary/CSV controls on an answer whose context is missing reply privately instead of overwriting it. No operator action required.
- Slack answers and escalation cards now stay within Block Kit limits (#33). Oversized result previews and single values are truncated with a note, and oversized previews point to the CSV export. SQL shown in an answer or an escalation is split at line breaks across up to ten sections, about 29,000 characters. Longer SQL ends with an explicit truncation note, and the stored SQL used for re-runs and ✅ confirmation is unchanged.
- Thread state is now scoped to its Slack conversation as well as its thread timestamp, so two conversations that share a timestamp no longer share locks, pending clarifications, escalation guards and cards, saved answers (and the buttons that read them) or follow-up answer context (#30). Lookups page through every same-timestamp record instead of stopping at a fixed count, so a conversation's own state can't be hidden behind others'. No new Firestore indexes or operator action are required. After upgrading, answers saved earlier have no recorded conversation and are not used for follow-ups or thread participation: reply-without-mention in an older channel thread needs one fresh @mention, and in-flight locks from before the upgrade are ignored (they expire within five minutes; while old and new revisions overlap during a rolling deploy, the same thread can briefly run twice). Buttons on older answers keep working.
- A ✅ reaction on a DM-mode escalation card now confirms the escalation; it was silently ignored because the card's stored destination (the analyst's user id) never equalled the DM's channel id.

## 0.1.0 - 2026-11-18

### Added

- Initial template baseline: Slack question-to-SQL pipeline, layered validation,
  human escalation, dbt metadata, ReferenceCards and knowledge sync, benchmark
  tools, and the gated WhatsApp prototype (merged history through #119).
- Template update instructions and this release history.

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
- Documentation identifies `NODE_PROFILE_OVERRIDES` and `MODEL_ID_OVERRIDES` as
  the production Gemini model controls; legacy model-alias settings are not
  serving controls (#111). Runtime defaults are unchanged.

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
- **Action required — INT64 results (#104):** unsafe INT64 values retain exact
  decimal strings, including nested results. Consumers of query results should
  allow strings for integers outside the JavaScript safe range.
- **Action required — query timeout (#96):** the configured `QUERY_TIMEOUT_MS`
  now reaches BigQuery job configuration as a number and is enforced; long
  queries may now terminate at that limit. Review the value before updating.
- Terraform Secret Manager automatic-replication syntax now parses (#97).
- dbt artifact path resolution preserves absolute paths across runtime and tools (#113).
- **Action required — WhatsApp allowlist (#117):** formatted tester IDs are
  normalized; invalid entries now fail startup. Check `WHATSAPP_ALLOWED_WA_IDS`
  before updating.
- **Action required — final SQL validation (#119):** final SQL passes shared
  L1–L4 validation before every execution, including best-effort answers.
  Expect rejected SQL to stop before execution; successful queries incur an
  additional dry run. Verify warehouse validation and cost limits before deploying.
- **Action required — numeric settings (#112):** every numeric environment
  setting must be a positive safe integer (blank/unset uses the default; `PORT`
  must be a valid TCP port; escalation reminder/timeout values are bounded).
  Fractional, negative, infinite, or out-of-range values now fail startup with
  an error naming the variable, instead of silently becoming zero or unbounded.
  Response-context retention uses the same shared parser. Check numeric env
  values against `.env.example` before updating.
- **Action required — dbt relation identity (#114):** schema, sampling, and
  INFORMATION_SCHEMA contexts use physical three-part `project.dataset.table`
  names from dbt `relation_name` (or database/schema/alias when absent);
  ephemeral models are no longer advertised as queryable, and malformed
  `relation_name` values skip the node with a warning. Legacy `dataset.table`
  names in ReferenceCards, teachings, and benchmark expectations resolve only
  when unique across the advertised inventory; ambiguous names are rejected or
  left unattributed. Routine fast-path SQL resolves two-part references only in
  the execution default project. Migrate knowledge and expectations to
  three-part names and re-run benchmark acceptance.
- **Action required — dbt status ingestion (#116):** dbt `warn`, no-op, and
  reused outcomes are stored distinctly instead of as `skipped`; partial success
  and runtime errors map to error rather than `skipped`. Records ingested before this change keep
  their old status — re-ingest recent `run_results.json` if dbt status answers
  matter to you.
- **Action required — infrastructure validation (#115):** `npm run infra:validate`
  now fails when neither Terraform nor OpenTofu is installed instead of passing
  silently; install one of them to validate `infra/` locally. A credential-free
  CI job runs the same validation on pull requests and main.

PR references: https://github.com/domainmethods/annalytics/pulls?q=is%3Apr+is%3Amerged
