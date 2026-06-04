# ReferenceCard Acceptance - 2026-06-04

**Decision:** `NEEDS_REVISION`

## Run Provenance

| Field | Value |
|-------|-------|
| Run ID | benchmark_2026-06-04T21-32-38-147Z |
| Started | 2026-06-04T21:32:38.147Z |
| Git SHA | 1340acdc343a44bac6733db471333cd1111b1440 |
| Dirty | false |
| Corpus Hash | b91b8fa44ebf30608de6c2e4364277b148f7574e0a0ac27de83c50bcb5b651a3 |
| dbt Manifest Hash | (not available) |
| dbt Catalog Hash | (not available) |
| Gemini Model | gemini-3.0-pro |
| File Search Store |  |

## Revenue Scorecard

| Corpus ID | Status | Retrieval | Tables | SQL Shape | L1/L3/L4 | L2 |
|-----------|--------|-----------|--------|-----------|----------|----|
| revenue-ref-001 | fail | false | false | false | false | advisory_fail |
| revenue-ref-002 | fail | false | false | false | false | advisory_fail |
| revenue-ref-003 | fail | false | false | false | false | advisory_fail |
| revenue-ref-004 | fail | false | false | false | false | advisory_fail |
| revenue-ref-005 | fail | n/a | n/a | n/a | false | advisory_fail |

## Failures

| Corpus ID | Class | Detail |
|-----------|-------|--------|
| __metadata__ | missing_metadata | metadata.fileSearchStoreId is required |
| revenue-ref-001 | retrieval_miss | Expected references revenue-canonical-definition; observed (none) |
| revenue-ref-001 | table_mismatch | Expected tables analytics.fct_orders; observed (none) |
| revenue-ref-001 | sql_shape_mismatch | Generated SQL did not contain all expected fragments: analytics.fct_orders, order_status = 'completed' |
| revenue-ref-001 | pipeline_failure | Quality loop ended with verdict exhausted |
| revenue-ref-001 | validation_failure | Final SQL failed L1, L3, L4 |
| revenue-ref-002 | retrieval_miss | Expected references revenue-monthly-grain; observed (none) |
| revenue-ref-002 | table_mismatch | Expected tables analytics.fct_orders; observed (none) |
| revenue-ref-002 | sql_shape_mismatch | Generated SQL did not contain all expected fragments: analytics.fct_orders, DATE_TRUNC, MONTH, order_status = 'completed' |
| revenue-ref-002 | pipeline_failure | Quality loop ended with verdict exhausted |
| revenue-ref-002 | validation_failure | Final SQL failed L1, L3, L4 |
| revenue-ref-003 | retrieval_miss | Expected references revenue-customer-lifetime-value; observed (none) |
| revenue-ref-003 | table_mismatch | Expected tables analytics.fct_orders, analytics.dim_customers; observed (none) |
| revenue-ref-003 | sql_shape_mismatch | Generated SQL did not contain all expected fragments: analytics.fct_orders, analytics.dim_customers, customer_id, SUM, order_status = 'completed' |
| revenue-ref-003 | pipeline_failure | Quality loop ended with verdict exhausted |
| revenue-ref-003 | validation_failure | Final SQL failed L1, L3, L4 |
| revenue-ref-004 | retrieval_miss | Expected references revenue-refunds-exclusions; observed (none) |
| revenue-ref-004 | table_mismatch | Expected tables analytics.fct_orders; observed (none) |
| revenue-ref-004 | sql_shape_mismatch | Generated SQL did not contain all expected fragments: analytics.fct_orders, order_status = 'completed' |
| revenue-ref-004 | pipeline_failure | Quality loop ended with verdict exhausted |
| revenue-ref-004 | validation_failure | Final SQL failed L1, L3, L4 |
| revenue-ref-005 | clarification_mismatch | Expected clarification confidence low |

## Suggested Next Action

Tighten the failing layer before expanding domain scope.