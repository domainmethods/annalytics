# Revenue ReferenceCard v1 Trust Tranche

**Date:** 2026-06-04
**Status:** Design
**Governance:** `docs/trajectory-governance.md`

## Decision

The next logical tranche is a narrow **Revenue ReferenceCard v1 Pilot**.

This tranche should prove that curated, typed business references improve Anna Lytics' SQL choices before the product adds more output modes or agentic routing. It combines three pieces that need to be evaluated together:

1. A typed `ReferenceCard v1` schema.
2. A small revenue-domain content set.
3. Benchmark and CI evidence that the cards are valid, retrieved, and useful.

Revenue is the first domain because the existing corpus and teaching fixtures already contain revenue ambiguity, table-selection expectations, and canonical filter rules. It is specific enough for a tight pilot and common enough to reveal whether the reference-card layer changes behavior.

## Alternatives Considered

### Option A: Content-Only ReferenceCards

Add reference-card YAML and sync it to File Search with minimal runtime or benchmark changes.

Tradeoff: fastest to create, but weak evidence. The team would know the cards exist, not whether they improve SQL generation or retrieval.

### Option B: Benchmark-Only Hardening

Keep improving benchmark metadata, judging, and reports before adding new content primitives.

Tradeoff: useful infrastructure, but it evaluates the current system rather than testing the governance recommendation around curated references.

### Option C: Combined Revenue Pilot

Add typed reference cards, validate and sync them, integrate them into the existing File Search context, and add benchmark expectations for the revenue slice.

Tradeoff: slightly larger than either isolated option, but it proves the full content loop end to end. This is the selected approach.

## Tranche Boundary

This tranche is not a general documentation system. It should support one domain and one new content primitive.

In scope:

- `ReferenceCard v1` type and YAML schema.
- `references/revenue.yml` with 5-10 revenue cards.
- Parser, markdown conversion, and integrity validation for reference cards.
- File Search sync of teachings plus reference cards into the existing store.
- Benchmark corpus additions for revenue questions.
- Benchmark fields for expected reference IDs and observed grounding citations.
- Minimal prompt wording update so SQL generation treats File Search as teachings plus reference cards.
- Governance update recording the selected tranche and design doc.

Out of scope:

- Domain agents.
- Generic documentation routers.
- Broad chart rollout.
- BQML expansion as a product goal.
- Automatic correction harvesting.
- New Slack UI.
- Separate vector store, embedding pipeline, or custom retrieval ranking.
- Multi-domain reference-card expansion.

## ReferenceCard v1 Schema

Reference cards are source-controlled YAML records. The source of truth should live under `references/`.

File shape:

```yaml
reference_cards:
  - id: revenue-canonical-definition
    title: Canonical Revenue Definition
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    required_filters:
      - order_status = 'completed'
    exclusions:
      - cancelled orders
      - refunded orders
    avoid_tables:
      - analytics.fct_revenue
    aliases:
      - revenue
      - sales
      - gross revenue
    routing_triggers:
      - total revenue
      - revenue last month
      - monthly revenue
    owner: finance-analytics
    freshness_sla: refreshed daily after dbt build
    related_teachings:
      - revenue-monthly
    updated: "2026-06-04"
```

TypeScript shape:

```typescript
export interface ReferenceCard {
  id: string;
  title: string;
  domain: string;
  grain: string;
  canonical_table: string;
  canonical_metric: string;
  required_filters: string[];
  exclusions: string[];
  avoid_tables: string[];
  aliases: string[];
  routing_triggers: string[];
  owner: string;
  freshness_sla: string;
  related_teachings: string[];
  updated: string;
}
```

Required fields:

- `id`
- `title`
- `domain`
- `grain`
- `canonical_table`
- `canonical_metric`
- `owner`
- `freshness_sla`
- `updated`

Array fields may be empty only where empty is meaningful. `routing_triggers` and `aliases` must each include at least one value because retrieval depends on them.

## Revenue Pilot Cards

The pilot should start with these cards:

1. `revenue-canonical-definition`: canonical table, metric, completed-order filter, exclusions.
2. `revenue-monthly-grain`: month bucketing, date column, ordering, and expected grouping.
3. `revenue-customer-lifetime-value`: customer-level aggregation and join expectations.
4. `revenue-refunds-exclusions`: refunded/cancelled order exclusion rules.
5. `revenue-ambiguous-intake`: clarification behavior when the user only says "revenue".

Optional cards if the first five are clean:

6. `revenue-time-window-defaults`: handling "last month", "last quarter", and unspecified periods. Add this only if the first five cards are implemented cleanly; it is not required by v1 benchmark acceptance.
7. `revenue-table-disambiguation`: when to use `analytics.fct_orders` and when not to use similarly named tables.

The first pass should not exceed 10 cards.

## Module Design

Add a new domain module rather than overloading teachings:

```text
src/references/
  types.ts
  parser.ts
  markdownConverter.ts
  validation.ts
```

Responsibilities:

- `types.ts`: `ReferenceCard` and `ReferenceCardFile`.
- `parser.ts`: parse `reference_cards` YAML arrays, coerce string arrays, and fail on missing required fields.
- `markdownConverter.ts`: convert cards into retrieval-friendly markdown with stable `ReferenceCard: <id>` headings.
- `validation.ts`: enforce duplicate IDs, required fields, non-empty retrieval triggers, valid date format, valid `canonical_table`/`avoid_tables` when dbt artifacts exist, and valid `related_teachings` when teaching IDs are available.

Keep `src/teachings/` focused on teaching-specific records. Shared helpers can be extracted only if real duplication emerges after implementation.

## File Search Sync Design

Use the existing File Search store. Do not add a second retrieval store in this tranche.

The sync path should evolve from "sync teachings" to "sync knowledge":

- Keep `scripts/sync-teachings.ts` working for compatibility if needed.
- Add `scripts/sync-knowledge.ts` or internal helpers that load both `teachings/` and `references/`.
- Upload teaching markdown with display names like `teaching:<id>`.
- Upload reference-card markdown with display names like `reference_card:<id>`.
- Update the workflow path filters to include `references/**/*.yml` and `references/**/*.yaml`.
- Validate teachings and reference cards before any upload.

Markdown format should make cards self-contained:

```markdown
# ReferenceCard: revenue-canonical-definition
Domain: revenue
Owner: finance-analytics
Updated: 2026-06-04
Canonical table: analytics.fct_orders
Canonical metric: total_amount
Grain: order

## Routing Triggers
- total revenue
- revenue last month

## Required Filters
- order_status = 'completed'

## Exclusions
- cancelled orders
- refunded orders

## Avoid Tables
- analytics.fct_revenue

## Related Teachings
- revenue-monthly
```

## Runtime Integration

Do not add a new routing stage or domain agent.

Change only the SQL-generation context wording from teachings-only to knowledge-context wording:

- Current behavior: File Search is passed as a tool when `fileSearchStoreId` exists.
- Desired behavior: The prompt says File Search may retrieve teachings and reference cards. The model must follow sanctioned SQL patterns and reference-card constraints when they apply.

The runtime should continue to degrade gracefully when File Search is unavailable. If retrieval fails and confidence would otherwise be high, keep the existing confidence cap behavior.

Grounding citations should remain the mechanism for observing whether cards were retrieved. Do not add a user-facing citation footer in this tranche.

## Benchmark Design

Extend the benchmark types:

```typescript
expectedReferenceIds?: string[];
```

Add revenue cases that test card behavior:

- "What was total revenue last month?" expects `revenue-canonical-definition`.
- "Show monthly revenue this year" expects `revenue-monthly-grain`.
- "Top 10 customers by lifetime value" expects `revenue-customer-lifetime-value`.
- "Should refunds count in revenue?" expects `revenue-refunds-exclusions`.
- "revenue" expects low-confidence clarification or an ambiguity path, not arbitrary SQL.

Benchmark output should include:

- Existing run metadata.
- Existing validation-layer results.
- `expectedReferenceIds`.
- `observedReferenceIds`, inferred from grounding citation source names or retrieved chunk text.
- A pass/fail indicator for expected reference retrieval.

This tranche does not require an LLM judge to score reference compliance. Deterministic retrieval and SQL-shape assertions are enough for v1.

## Validation and CI

Reference-card validation should run in the same CI path as teaching sync.

Structural checks:

- Duplicate card IDs fail.
- Missing required fields fail.
- Empty `aliases` or `routing_triggers` fail.
- Malformed `updated` dates fail.
- `domain` for pilot cards must be `revenue`.

Artifact-aware checks:

- If dbt artifacts are available, `canonical_table` and `avoid_tables` must exist in parsed dbt metadata.
- If dbt artifacts are missing, skip only table-reference checks.

Teaching-aware checks:

- If teachings are available, `related_teachings` must refer to known teaching IDs.
- If no teachings are available, skip only the related-teaching existence check.

Workflow checks:

- Trigger on `teachings/**`, `references/**`, sync scripts, and validation modules.
- Authenticate to GCP before dry-run or Firestore/File Search sync.
- Validate before upload.
- Upload only after validation succeeds.

## Testing

Add focused tests:

- Parser accepts valid `reference_cards` YAML.
- Parser rejects missing required fields.
- Validation rejects duplicate IDs.
- Validation rejects missing aliases or routing triggers.
- Validation rejects missing/malformed `updated`.
- Validation skips dbt table checks when artifacts are missing.
- Markdown converter emits canonical fields and retrieval triggers.
- Sync helper includes both teachings and reference cards.
- Benchmark helper extracts observed reference IDs from grounding citations.
- Benchmark result records expected and observed reference IDs.

Use mocked Gemini, BigQuery, Firestore, and File Search clients. Do not use live external services in unit or integration tests.

## Acceptance Criteria

The tranche is complete when:

1. A revenue reference-card file with 5-10 cards exists.
2. Reference cards are parsed, validated, converted to markdown, and synced with teachings.
3. CI validates references before File Search upload.
4. The benchmark corpus includes revenue reference-card cases.
5. Benchmark output records expected and observed reference IDs.
6. At least one deterministic benchmark assertion verifies that a revenue case used the expected reference card.
7. The SQL generator prompt recognizes both teachings and reference cards in File Search context.
8. `docs/trajectory-governance.md` links this design as the selected next tranche.

## Risks and Mitigations

Risk: File Search citations do not reliably expose display names.

Mitigation: Include `ReferenceCard: <id>` in the markdown heading and infer observed IDs from either source names or chunk text.

Risk: Cards become generic docs.

Mitigation: Keep v1 fields operational: table, metric, filters, exclusions, aliases, triggers, owner, freshness. Reject long prose-only cards.

Risk: Revenue fixture tables differ from production dbt names.

Mitigation: Validation skips table checks when artifacts are absent, but benchmark cases should still declare expected tables. Production adoption should align cards with real dbt artifacts before sync.

Risk: Runtime prompt becomes too broad.

Mitigation: Use one short File Search instruction block. Do not add a new agent, router, or multi-step retrieval flow.

## Implementation Order

1. Add `src/references` types, parser, markdown converter, and validation.
2. Add revenue reference-card YAML.
3. Extend validation/sync scripts and workflow path filters.
4. Update SQL generator File Search wording.
5. Extend benchmark types and helpers for expected/observed reference IDs.
6. Add revenue benchmark cases and deterministic assertions.
7. Update `docs/trajectory-governance.md` with this selected design.

Each step should include targeted tests before implementation changes.
