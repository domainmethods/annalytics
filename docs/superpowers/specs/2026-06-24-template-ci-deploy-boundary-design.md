# Template CI/Deploy Boundary Design

**Date:** 2026-06-24
**Status:** Approved for implementation planning
**Scope:** Restore a truthful CI/deploy signal for the reusable template repository

## Summary

Make the GitHub Actions deploy phase opt-in while keeping code validation
always-on. The current workflow runs `Build, Test & Deploy` on every push to
`main`, but the deploy job requires `dbt/manifest.json` and `dbt/catalog.json`
to exist in the build workspace. Those files are intentionally gitignored
because this repository is a reusable template and must not commit
implementation-specific schema artifacts.

The result is a misleading red `main`: CI can pass, but the workflow fails
because the template correctly lacks client-specific dbt artifacts. This
tranche should preserve strict deploy validation for real implementations while
making the default template signal mean what it says: code validation passed or
failed.

## Context

The governance checkpoint says trust infrastructure takes precedence over
feature expansion, and that implementation-specific dbt artifacts, project IDs,
File Search store IDs, ReferenceCards, corpus retargets, and benchmark evidence
must remain out of the template repository.

The README currently states that pushing to `main` triggers deployment. That
was appropriate for an implementation branch that carries artifacts, but it is
wrong for the template posture. A normal template push cannot deploy a runtime
image because the Docker build context does not include the required dbt
artifacts.

This is not a product-domain tranche. Second-domain ReferenceCard work remains
gated on aggregated production feedback. WhatsApp remains a gated prototype
surface. This tranche only fixes the operational signal around CI and deploy.

## Goals

- Keep PR and `main` CI green when code, docs, and tests pass without requiring
  dbt artifacts.
- Keep deployment available for implementation repositories or explicitly
  requested template-operator runs.
- Fail deploy clearly when it is requested but required GitHub secrets,
  deploy configuration, or dbt artifacts are missing.
- Make the workflow name, README, setup check, and governance document describe
  the same behavior.
- Preserve the template boundary: no client dbt artifacts, project IDs, File
  Search store IDs, Cloud Run URLs, or benchmark evidence.

## Non-Goals

- Do not commit `dbt/manifest.json` or `dbt/catalog.json`.
- Do not design a universal artifact delivery service.
- Do not change runtime startup behavior for dbt artifact loading.
- Do not change local manual `gcloud run deploy` semantics except for README
  wording around when to use it.
- Do not add or promote product features.
- Do not deploy Cloud Run as part of this tranche.

## Alternatives Considered

### A. Split CI and Deploy Into Separate Workflows

Create a dedicated `ci.yml` for PR and `main` validation, and keep a separate
manual deploy workflow.

This gives the cleanest conceptual separation, but it touches more workflow
surface and requires updating required-file checks, README references, and any
existing operator expectations around `.github/workflows/deploy.yml`.

### B. Keep One Workflow With An Opt-In Deploy Phase

Keep `.github/workflows/deploy.yml`, rename it to `Build, Test & Optional
Deploy`, run the test job on PRs and `main`, and gate deployment behind either
manual `workflow_dispatch` or an explicit repository variable such as
`ANNALYTICS_AUTO_DEPLOY=true`.

This is the recommended approach. It is smaller, keeps existing setup-check
coverage, and still restores a truthful default signal. A visible deploy
decision job can write a step summary explaining that deploy was skipped unless
explicitly requested.

### C. Keep Automatic Deploy And Fetch Artifacts In CI

Preserve push-to-main deploy by downloading dbt artifacts from external storage
or a secret-backed artifact source.

This preserves automatic deploys for one implementation, but it pushes
implementation-specific artifact delivery into the reusable template. It also
adds secrets, storage conventions, and failure modes that are not necessary to
fix the current signal defect.

## Recommended Design

Use Alternative B.

The workflow keeps three logical phases:

1. **Test**
   - Runs on PRs, pushes to `main`, and manual runs.
   - Executes the current validation path: `npm ci`, `npm run
     knowledge:validate`, `npm run setup:check`, `npm run typecheck`, and
     `npm test`.
   - Does not authenticate to GCP.
   - Does not require dbt artifacts.

2. **Deploy Decision**
   - Runs after the test job on `main`.
   - Writes a short GitHub Actions step summary.
   - Sets `should_deploy=true` only when the run was manually dispatched or
     `vars.ANNALYTICS_AUTO_DEPLOY == 'true'`.
   - For normal template `main` pushes, sets `should_deploy=false` and explains
     that deploy was skipped because implementation artifacts are not expected
     in the template.

3. **Deploy**
   - Runs only when the deploy decision output is `true`.
   - Keeps the existing GCP authentication, Docker build/push, and Cloud Run
     deploy behavior.
   - Keeps strict checks for `GCP_PROJECT_ID`, `FILE_SEARCH_STORE_ID`,
     `WIF_PROVIDER`, `WIF_SERVICE_ACCOUNT`, `dbt/manifest.json`, and
     `dbt/catalog.json`.
   - Fails fast when an operator or implementation repo requests deploy without
     required configuration.

This keeps the template's default `main` green when CI passes, while preserving
push-to-main deployment for implementation repos that deliberately set
`ANNALYTICS_AUTO_DEPLOY=true`.

## Setup Check

`scripts/setup-check.ts` already verifies important README and workflow tokens.
Extend `checkReadme` and `checkDeployWorkflow` so a future docs or workflow edit
cannot silently remove the opt-in deploy boundary. The checks should require:

- README text stating template pushes do not deploy by default
- README text for `workflow_dispatch`
- README text for `ANNALYTICS_AUTO_DEPLOY`
- `workflow_dispatch:`
- `ANNALYTICS_AUTO_DEPLOY`
- a deploy-decision output such as `should_deploy`
- a deploy job condition that consumes that output
- the WIF deploy secrets used before GCP authentication
- the existing Cloud Run deployment flags and secret bindings

This keeps the safety net lightweight. It does not need a YAML parser because
the existing check is token-based and intentionally simple.

## Documentation

Update the README deployment section from "Automatic" to "CI and Optional
Deploy" or equivalent. It should state:

- PRs and pushes to `main` always run validation.
- Template pushes do not deploy by default.
- Manual deploy is available through GitHub Actions `workflow_dispatch` when
  run from `main`.
- Implementation repos that intentionally provide dbt artifacts in the build
  workspace may set `ANNALYTICS_AUTO_DEPLOY=true` to restore push-to-main
  deploy.
- A requested deploy still requires the dbt artifacts and GitHub/GCP secrets.

The manual deploy section remains useful for local operator deploys and should
stay intact.

## Governance

Update `docs/trajectory-governance.md` because the maintenance protocol says a
trust risk should be recorded when discovered. The update should be small:

- Note that the active product queue is unchanged.
- Record this tranche as operational signal maintenance.
- Reaffirm that implementation artifacts stay out of the template.
- Add an Evidence Log entry once the change lands.

## Testing

The implementation should use existing tests where possible:

- Update `tests/scripts/setup-check.test.ts` so the fixture deploy workflow
  includes the new opt-in tokens.
- Add a focused regression test proving `runSetupCheck` reports an error when
  a deploy workflow lacks the opt-in deploy boundary.
- Run `npx vitest run tests/scripts/setup-check.test.ts`.
- Run `npm run setup:check`.
- Run `npm run typecheck`.
- Run `npm test`.

GitHub verification after merge should confirm:

- PR test checks pass.
- `main` workflow passes when dbt artifacts are absent.
- The deploy job is skipped unless manually dispatched or enabled by
  `ANNALYTICS_AUTO_DEPLOY=true`.

## Acceptance Criteria

- Normal PR CI passes without dbt artifacts.
- Normal `main` push passes without dbt artifacts when tests pass.
- The workflow visibly reports that deploy was skipped by default.
- Manual or variable-enabled `main` deploy still performs the strict artifact
  and secret checks.
- README, setup check, workflow behavior, and governance agree.
- No implementation-specific artifacts or identifiers are committed.

## Risks And Mitigations

**Risk:** An implementation repo expects push-to-main deploy and loses it.

**Mitigation:** Provide the explicit `ANNALYTICS_AUTO_DEPLOY=true` repository
variable path.

**Risk:** A skipped deploy is mistaken for a successful deploy.

**Mitigation:** Use a deploy-decision job with a step summary that states
whether deploy was skipped or requested.

**Risk:** The workflow changes drift from README or setup guidance.

**Mitigation:** Extend `setup-check` to require the opt-in deploy tokens.

## Scope Boundary

This tranche fixes the deploy signal only. It does not select a second
ReferenceCard domain, promote WhatsApp, alter dbt startup loading, or introduce
new artifact hosting. Those decisions remain governed by the existing trajectory
checkpoint.
