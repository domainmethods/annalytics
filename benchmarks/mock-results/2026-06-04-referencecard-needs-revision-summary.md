# Benchmark Summary - 2026-06-04

No judge results available yet.

## ReferenceCard Acceptance

**Decision:** `NEEDS_REVISION`

Cases evaluated: 2

| Corpus ID | Class | Detail |
|-----------|-------|--------|
| revenue-ref-001 | retrieval_miss | Expected references revenue-canonical-definition; observed (none) |
| revenue-ref-001 | table_mismatch | Expected tables analytics.fct_orders; observed analytics.fct_revenue |
| revenue-ref-001 | sql_shape_mismatch | Generated SQL did not contain all expected fragments: analytics.fct_orders, order_status = 'completed' |
| revenue-ref-001 | validation_failure | Final SQL failed L3 |
| revenue-ref-005 | clarification_mismatch | Expected clarification confidence low |
