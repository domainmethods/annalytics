# ReferenceCard Acceptance - 2026-06-04

**Decision:** `NEEDS_REVISION`

## Run Provenance

| Field | Value |
|-------|-------|
| Run ID | benchmark_2026-06-04T23-52-59-607Z |
| Started | 2026-06-04T23:52:59.607Z |
| Git SHA | 5c727002aa91d3f58762396408ccf2354792c5c2 |
| Dirty | true |
| Corpus Hash | b91b8fa44ebf30608de6c2e4364277b148f7574e0a0ac27de83c50bcb5b651a3 |
| dbt Manifest Hash | b0f7d2bcc617ca32af35f185014326ecf0cdde13910a5ef60ff8334d7b00b399 |
| dbt Catalog Hash | 49c29ba45650ae5d261578327f854578cd905d4d4cab659abbf5dbabdff22ee6 |
| Gemini Model | gemini-pro-latest |
| File Search Store | fileSearchStores/annalyticsknowledge-s7el62hneuh6 |

## Revenue Scorecard

| Corpus ID | Status | Retrieval | Tables | SQL Shape | L1/L3/L4 | L2 |
|-----------|--------|-----------|--------|-----------|----------|----|
| revenue-ref-001 | fail | false | false | false | true | pass |
| revenue-ref-002 | fail | false | false | false | true | pass |
| revenue-ref-003 | fail | false | false | false | true | pass |
| revenue-ref-004 | fail | false | false | false | false | advisory_fail |
| revenue-ref-005 | pass | n/a | n/a | n/a | false | advisory_fail |

## Failures

| Corpus ID | Class | Detail |
|-----------|-------|--------|
| revenue-ref-001 | retrieval_miss | Expected references revenue-canonical-definition; observed (none) |
| revenue-ref-001 | table_mismatch | Expected tables analytics.fct_orders; observed analytics.stg_ga4__event_purchase |
| revenue-ref-001 | sql_shape_mismatch | Generated SQL did not contain all expected fragments: analytics.fct_orders, order_status = 'completed' |
| revenue-ref-002 | retrieval_miss | Expected references revenue-monthly-grain; observed (none) |
| revenue-ref-002 | table_mismatch | Expected tables analytics.fct_orders; observed analytics.stg_ga4__event_purchase |
| revenue-ref-002 | sql_shape_mismatch | Generated SQL did not contain all expected fragments: analytics.fct_orders, DATE_TRUNC, MONTH, order_status = 'completed' |
| revenue-ref-003 | retrieval_miss | Expected references revenue-customer-lifetime-value; observed (none) |
| revenue-ref-003 | table_mismatch | Expected tables analytics.fct_orders, analytics.dim_customers; observed analytics.stg_ga4__user_id_mapping, analytics.stg_ga4__event_purchase_deduplicated |
| revenue-ref-003 | sql_shape_mismatch | Generated SQL did not contain all expected fragments: analytics.fct_orders, analytics.dim_customers, customer_id, SUM, order_status = 'completed' |
| revenue-ref-004 | retrieval_miss | Expected references revenue-refunds-exclusions; observed (none) |
| revenue-ref-004 | table_mismatch | Expected tables analytics.fct_orders; observed (none) |
| revenue-ref-004 | sql_shape_mismatch | Generated SQL did not contain all expected fragments: analytics.fct_orders, order_status = 'completed' |
| revenue-ref-004 | pipeline_failure | Quality loop ended with verdict exhausted |
| revenue-ref-004 | validation_failure | Final SQL failed L1, L3, L4 |

## Suggested Next Action

Tighten the failing layer before expanding domain scope.