# ReferenceCard Acceptance - 2026-06-04

**Decision:** `NEEDS_REVISION`

## Run Provenance

| Field | Value |
|-------|-------|
| Run ID | mock_referencecard_acceptance_needs_revision |
| Started | 2026-06-04T12:30:00.000Z |
| Git SHA | ff1c05c |
| Dirty | false |
| Corpus Hash | mock-corpus-hash |
| dbt Manifest Hash | (not available) |
| dbt Catalog Hash | (not available) |
| Gemini Model | gemini-3.0-pro |
| File Search Store | mock-file-search-store |

## Revenue Scorecard

| Corpus ID | Status | Retrieval | Tables | SQL Shape | L1/L3/L4 | L2 |
|-----------|--------|-----------|--------|-----------|----------|----|
| revenue-ref-001 | fail | false | false | false | false | pass |
| revenue-ref-005 | fail | n/a | n/a | n/a | false | advisory_fail |

## Failures

| Corpus ID | Class | Detail |
|-----------|-------|--------|
| revenue-ref-001 | retrieval_miss | Expected references revenue-canonical-definition; observed (none) |
| revenue-ref-001 | table_mismatch | Expected tables analytics.fct_orders; observed analytics.fct_revenue |
| revenue-ref-001 | sql_shape_mismatch | Generated SQL did not contain all expected fragments: analytics.fct_orders, order_status = 'completed' |
| revenue-ref-001 | validation_failure | Final SQL failed L3 |
| revenue-ref-005 | clarification_mismatch | Expected clarification confidence low |

## Suggested Next Action

Tighten the failing layer before expanding domain scope.