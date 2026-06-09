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
| Judge Model | gemini-3.0-pro |
| GCP Project | mock-project |

## Calibration

**Verdict:** `FAIL`

Reason: 5 benchmark result(s) had no judge result

Wrong rule: `flaggedForReview || correctness < 3`

Monotonic rule: `low >= medium >= high`, min sample `5`, low-high delta `0.05`.

No judge-backed confidence buckets available.

## ReferenceCard Scorecard

| Corpus ID | Status | Retrieval | Teaching | Source | Tables | SQL Shape | L1/L3/L4 | L2 |
|-----------|--------|-----------|----------|--------|--------|-----------|----------|----|
| revenue-ref-001 | pass | true | n/a | legacy | true | true | true | pass |
| revenue-ref-002 | pass | true | n/a | legacy | true | true | true | advisory_fail |
| revenue-ref-003 | pass | true | n/a | legacy | true | true | true | pass |
| revenue-ref-004 | pass | true | n/a | legacy | true | true | true | pass |
| revenue-ref-005 | pass | n/a | n/a | none | n/a | n/a | false | advisory_fail |

## Failures

No acceptance failures.

## Suggested Next Action

Expand to one next high-confusion domain.