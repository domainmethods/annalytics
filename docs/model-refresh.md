# Model refresh

Use the frozen set in `benchmarks/template-validation/` to review template defaults when Gemini models appear or disappear. Export `GEMINI_API_KEY` and `GCP_PROJECT_ID` or set them in your local `.env`, and configure BigQuery credentials for that project.

1. Run `npm run model:discover`. Review new and missing models, including missing IDs used by defaults. Add the probed entries to `src/agents/modelConfig.ts`, assign each a tier, and set its rates from [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing). Keep model IDs pinned and exclude `*-latest` aliases.
2. Run `npm run tv:setup` on the first run and when using a new machine or project. It creates the `tv_thelook` views over `bigquery-public-data.thelook_ecommerce` and generates the template dbt artifacts.

   On the first run from the seed-only checkout, run `npm run tv:label` after setup to build the initial set. Use authenticated local agent CLIs and a BigQuery labeling principal with job creation permission and data access scoped to the template views and the public TheLook dataset. Labels require unanimous agreement. The default is three distinct families. Two produce a reduced quorum, and one requires `npm run tv:label -- --allow-single-family`. Multiple CLIs from the same family count once.

   Each labeler runs in a temporary working directory with an allowlist of shell and CLI login variables. It still runs as the operator, with access to its home directory and any tools its CLI permits. The probe notes in `provenance.json` record that access. For example, Antigravity wrote outside the working directory in its probe, and Codex called MCP discovery tools.

   A full label run freezes all 12 nodes. A `tv:label -- --node <node>` run saves drafts and provenance under the ignored, version-scoped cache. Sweeps verify the selected item files against the SHA-256 digests in the root provenance for the current `VERSION`. Later refreshes reuse that frozen set. Bump `VERSION` and relabel all nodes if an older frozen set lacks digests.

3. Clear `MODEL_ID_OVERRIDES` and `NODE_PROFILE_OVERRIDES` from both the shell environment and the local `.env`, then run `npm run sweep:template`. Template mode refuses to start if either variable is populated. It runs `node-sweep --corpus template` for all 12 nodes using the frozen set and writes `benchmarks/results/<date>-model-refresh.md` and `benchmarks/results/<date>-model-refresh.json` locally. A subset selected with `--node` adds `-partial-<node names>` to the report filenames.
4. Review the reduced-quorum or single-family banner if present. Use the final `Applicable` column to decide which recommendations are eligible. Apply eligible strong or medium recommendations. Record the judgment behind any eligible weak recommendation in the commit message.

   The report shows each node's accepted count and the fraction of drafted items that were quarantined. The accepted count includes manual seeds. A row with fewer than half its target items is ineligible as `underfilled corpus`. The targets are 100 each for SQL generation and supervisor, and 40 for each other node.

   A row is also ineligible if ε > 0.05, the scores are flat at the floor, the recommendation equals the current profile, both profiles resolve to the same ID with the same thinking level, or infrastructure failures affect the comparison.

   A supervisor-only sweep withholds its pick pending SQL comparator verification. The SQL cross-pass verifies only an applicable supervisor pick. Its comparator is the eligible SQL generator pick with the default supervisor, or the SQL baseline if the generator pick is ineligible. A non-candidate failure on the comparator blocks the supervisor row before verification. A non-candidate failure in the paired run makes the supervisor row inapplicable, even if the proposed profile is still visible. With a valid comparison, the cross-pass reverts the supervisor pick if the SQL metric drops or the loop-exhaustion rate rises by more than the SQL row's ε.

5. Update the applicable `DEFAULTS` entries in `src/agents/nodeProfiles.ts` and align the model defaults in `.env.example` and the `DEFAULT_*_MODEL` constants. Mark superseded registry entries `retired` once no default or documented override uses them.
6. Commit only the default changes and their supporting registry updates. Cite the set version and measurement date in each measured `DEFAULTS` comment, for example `TEMPLATE-MEASURED tv-v1 2026-12-02`. The refresh reports are gitignored. Keep benchmark evidence, project IDs, store IDs, and client data local.

For an installation sweep, export the installation environment first, including `GEMINI_API_KEY` and `GCP_PROJECT_ID`. The plain `node-sweep` script does not load `.env`. Run `npm run node-sweep -- --corpus <path>` with the installation corpus path. Size install-coupled nodes on local data and set `NODE_PROFILE_OVERRIDES` according to the [per-node sizing rules](../src/agents/CLAUDE.md).
