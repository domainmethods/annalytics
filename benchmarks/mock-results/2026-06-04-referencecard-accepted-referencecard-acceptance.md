# ReferenceCard Acceptance - 2026-06-04

**Decision:** `ACCEPTED`

## Run Provenance

| Field | Value |
|-------|-------|
| Run ID | mock_referencecard_acceptance_accepted |
| Started | 2026-06-04T12:00:00.000Z |
| Git SHA | ff1c05c |
| Dirty | false |
| Corpus Hash | mock-corpus-hash |
| dbt Manifest Hash | (not available) |
| dbt Catalog Hash | (not available) |
| Gemini Model | gemini-3.0-pro |
| File Search Store | mock-file-search-store |

## ReferenceCard Scorecard

| Corpus ID | Status | Retrieval | Tables | SQL Shape | L1/L3/L4 | L2 |
|-----------|--------|-----------|--------|-----------|----------|----|
| revenue-ref-001 | pass | true | true | true | true | pass |
| revenue-ref-002 | pass | true | true | true | true | advisory_fail |
| revenue-ref-003 | pass | true | true | true | true | pass |
| revenue-ref-004 | pass | true | true | true | true | pass |
| revenue-ref-005 | pass | n/a | n/a | n/a | false | advisory_fail |

## Failures

No acceptance failures.

## Suggested Next Action

Expand to one next high-confusion domain.
