# Revenue ReferenceCard v1 Trust Tranche Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a narrow revenue-domain `ReferenceCard v1` content primitive, validate and sync it with teachings, and make benchmark output prove whether the expected cards were retrieved.

**Architecture:** Add a focused `src/references/` module for typed reference cards and keep `src/teachings/` teaching-specific. Convert teachings and reference cards into generic File Search markdown documents for one shared store. Extend benchmarks with expected/observed reference-card IDs while keeping runtime changes to a short SQL-generator prompt update.

**Tech Stack:** TypeScript, Vitest, YAML, Gemini File Search via `@google/genai`, existing BigQuery/Firestore validation scripts.

---

## File Structure

Create:

- `src/references/types.ts` — `ReferenceCard` and `ReferenceCardFile` types.
- `src/references/parser.ts` — parse and validate `reference_cards` YAML structure.
- `src/references/validation.ts` — integrity checks for duplicate IDs, required retrieval fields, dates, dbt table references, teaching references, and pilot domain.
- `src/references/markdownConverter.ts` — convert reference cards to retrieval-friendly markdown.
- `scripts/knowledgeSupport.ts` — load teachings and reference cards, validate both, and build File Search documents.
- `scripts/validate-knowledge.ts` — CI validation entry point for teachings plus references.
- `scripts/sync-knowledge.ts` — File Search and Firestore sync entry point for teachings plus references.
- `references/revenue.yml` — first revenue-domain reference cards.
- `tests/references/parser.test.ts`
- `tests/references/validation.test.ts`
- `tests/references/markdownConverter.test.ts`
- `tests/scripts/knowledgeSupport.test.ts`

Modify:

- `src/teachings/fileSearchSync.ts` — add generic markdown-document sync while preserving `syncTeachingsToFileSearch`.
- `src/agents/sqlGenerator.ts` — change File Search wording from teachings-only to knowledge context.
- `scripts/benchmark-types.ts` — add reference-card expectation and observation fields.
- `scripts/benchmarkSupport.ts` — add reference-card ID extraction and pass/fail helpers.
- `scripts/benchmark.ts` — record expected/observed reference-card IDs.
- `benchmarks/corpus.json` — add revenue reference-card cases and expectations.
- `tests/teachings/fileSearchSync.test.ts`
- `tests/agents/sqlGenerator.filesearch.test.ts`
- `tests/scripts/benchmarkSupport.test.ts`
- `tests/scripts/benchmark.test.ts`
- `.github/workflows/sync-teachings.yml` — trigger and run knowledge validation/sync.
- `docs/trajectory-governance.md` — record execution status when this tranche lands.

---

## Task 1: Add ReferenceCard Types and Parser

**Files:**
- Create: `src/references/types.ts`
- Create: `src/references/parser.ts`
- Create: `tests/references/parser.test.ts`

- [ ] **Step 1: Write the failing parser tests**

Create `tests/references/parser.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseReferenceCardFile } from '../../src/references/parser.js';

const validYaml = `
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
    routing_triggers:
      - total revenue
      - revenue last month
    owner: finance-analytics
    freshness_sla: refreshed daily after dbt build
    related_teachings:
      - revenue-monthly
    updated: "2026-06-04"
`;

describe('parseReferenceCardFile', () => {
  it('parses a valid reference_cards YAML file', () => {
    const cards = parseReferenceCardFile(validYaml);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual({
      id: 'revenue-canonical-definition',
      title: 'Canonical Revenue Definition',
      domain: 'revenue',
      grain: 'order',
      canonical_table: 'analytics.fct_orders',
      canonical_metric: 'total_amount',
      required_filters: ["order_status = 'completed'"],
      exclusions: ['cancelled orders', 'refunded orders'],
      avoid_tables: ['analytics.fct_revenue'],
      aliases: ['revenue', 'sales'],
      routing_triggers: ['total revenue', 'revenue last month'],
      owner: 'finance-analytics',
      freshness_sla: 'refreshed daily after dbt build',
      related_teachings: ['revenue-monthly'],
      updated: '2026-06-04',
    });
  });

  it('rejects files without a reference_cards array', () => {
    expect(() => parseReferenceCardFile('cards: []')).toThrow(
      'Reference card file must have a "reference_cards" array',
    );
  });

  it('rejects missing required scalar fields', () => {
    const yaml = `
reference_cards:
  - id: revenue-canonical-definition
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    owner: finance-analytics
    freshness_sla: refreshed daily
    updated: "2026-06-04"
`;

    expect(() => parseReferenceCardFile(yaml)).toThrow(
      'ReferenceCard at index 0 is missing required field: title',
    );
  });

  it('coerces missing array fields to empty arrays', () => {
    const yaml = `
reference_cards:
  - id: revenue-canonical-definition
    title: Canonical Revenue Definition
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    owner: finance-analytics
    freshness_sla: refreshed daily
    updated: "2026-06-04"
`;

    const cards = parseReferenceCardFile(yaml);
    expect(cards[0].required_filters).toEqual([]);
    expect(cards[0].aliases).toEqual([]);
    expect(cards[0].routing_triggers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the parser tests to verify they fail**

Run:

```bash
npx vitest run tests/references/parser.test.ts
```

Expected: FAIL with an import error for `src/references/parser.js`.

- [ ] **Step 3: Add `ReferenceCard` types**

Create `src/references/types.ts`:

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

export interface ReferenceCardFile {
  reference_cards: ReferenceCard[];
}
```

- [ ] **Step 4: Add the parser implementation**

Create `src/references/parser.ts`:

```typescript
import { parse as parseYaml } from 'yaml';
import type { ReferenceCard } from './types.js';

const REQUIRED_FIELDS = [
  'id',
  'title',
  'domain',
  'grain',
  'canonical_table',
  'canonical_metric',
  'owner',
  'freshness_sla',
  'updated',
] as const;

export function parseReferenceCardFile(yamlContent: string): ReferenceCard[] {
  const parsed = parseYaml(yamlContent) as { reference_cards?: unknown[] };
  if (!parsed?.reference_cards || !Array.isArray(parsed.reference_cards)) {
    throw new Error('Reference card file must have a "reference_cards" array');
  }

  return parsed.reference_cards.map((raw, index) =>
    validateReferenceCard(raw as Record<string, unknown>, index),
  );
}

function validateReferenceCard(raw: Record<string, unknown>, index: number): ReferenceCard {
  for (const field of REQUIRED_FIELDS) {
    if (raw[field] === undefined || raw[field] === null || String(raw[field]).trim() === '') {
      throw new Error(`ReferenceCard at index ${index} is missing required field: ${field}`);
    }
  }

  return {
    id: String(raw.id),
    title: String(raw.title),
    domain: String(raw.domain),
    grain: String(raw.grain),
    canonical_table: String(raw.canonical_table),
    canonical_metric: String(raw.canonical_metric),
    required_filters: asStringArray(raw.required_filters) ?? [],
    exclusions: asStringArray(raw.exclusions) ?? [],
    avoid_tables: asStringArray(raw.avoid_tables) ?? [],
    aliases: asStringArray(raw.aliases) ?? [],
    routing_triggers: asStringArray(raw.routing_triggers) ?? [],
    owner: String(raw.owner),
    freshness_sla: String(raw.freshness_sla),
    related_teachings: asStringArray(raw.related_teachings) ?? [],
    updated: String(raw.updated),
  };
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(String);
}
```

- [ ] **Step 5: Run parser tests**

Run:

```bash
npx vitest run tests/references/parser.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/references/types.ts src/references/parser.ts tests/references/parser.test.ts
git commit -m "feat: add reference card parser"
```

---

## Task 2: Add ReferenceCard Integrity Validation

**Files:**
- Create: `src/references/validation.ts`
- Create: `tests/references/validation.test.ts`

- [ ] **Step 1: Write the failing validation tests**

Create `tests/references/validation.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { validateReferenceCards } from '../../src/references/validation.js';
import type { ReferenceCard } from '../../src/references/types.js';

function card(overrides: Partial<ReferenceCard> = {}): ReferenceCard {
  return {
    id: 'revenue-canonical-definition',
    title: 'Canonical Revenue Definition',
    domain: 'revenue',
    grain: 'order',
    canonical_table: 'analytics.fct_orders',
    canonical_metric: 'total_amount',
    required_filters: ["order_status = 'completed'"],
    exclusions: ['cancelled orders', 'refunded orders'],
    avoid_tables: ['analytics.fct_revenue'],
    aliases: ['revenue'],
    routing_triggers: ['total revenue'],
    owner: 'finance-analytics',
    freshness_sla: 'refreshed daily after dbt build',
    related_teachings: ['revenue-monthly'],
    updated: '2026-06-04',
    ...overrides,
  };
}

describe('validateReferenceCards', () => {
  it('rejects duplicate IDs', () => {
    const errors = validateReferenceCards([
      card(),
      card({ title: 'Duplicate Revenue Definition' }),
    ]);

    expect(errors).toContain('Duplicate reference card id: revenue-canonical-definition');
  });

  it('rejects empty aliases and routing triggers', () => {
    const errors = validateReferenceCards([
      card({ aliases: [], routing_triggers: [] }),
    ]);

    expect(errors).toContain('ReferenceCard revenue-canonical-definition must include at least one alias');
    expect(errors).toContain('ReferenceCard revenue-canonical-definition must include at least one routing trigger');
  });

  it('rejects malformed updated dates', () => {
    const errors = validateReferenceCards([
      card({ updated: '' }),
      card({ id: 'bad-date', updated: '2026/06/04' }),
    ]);

    expect(errors).toContain('ReferenceCard revenue-canonical-definition has invalid or missing updated date: ');
    expect(errors).toContain('ReferenceCard bad-date has invalid or missing updated date: 2026/06/04');
  });

  it('enforces the revenue pilot domain', () => {
    const errors = validateReferenceCards([
      card({ domain: 'churn' }),
    ], { allowedDomains: new Set(['revenue']) });

    expect(errors).toContain('ReferenceCard revenue-canonical-definition has unsupported domain: churn');
  });

  it('rejects table references missing from dbt artifacts when artifacts are available', () => {
    const errors = validateReferenceCards([
      card({ canonical_table: 'analytics.missing_table', avoid_tables: ['analytics.other_missing'] }),
    ], { validTableNames: new Set(['analytics.fct_orders']) });

    expect(errors).toContain('ReferenceCard revenue-canonical-definition references unknown canonical_table: analytics.missing_table');
    expect(errors).toContain('ReferenceCard revenue-canonical-definition references unknown avoid_table: analytics.other_missing');
  });

  it('skips table validation when dbt artifacts are unavailable', () => {
    const errors = validateReferenceCards([
      card({ canonical_table: 'analytics.missing_table' }),
    ], { validTableNames: undefined });

    expect(errors).not.toContain('ReferenceCard revenue-canonical-definition references unknown canonical_table: analytics.missing_table');
  });

  it('rejects related teachings missing from known teaching IDs', () => {
    const errors = validateReferenceCards([
      card({ related_teachings: ['missing-teaching'] }),
    ], { validTeachingIds: new Set(['revenue-monthly']) });

    expect(errors).toContain('ReferenceCard revenue-canonical-definition references unknown related teaching: missing-teaching');
  });
});
```

- [ ] **Step 2: Run validation tests to verify they fail**

Run:

```bash
npx vitest run tests/references/validation.test.ts
```

Expected: FAIL with an import error for `src/references/validation.js`.

- [ ] **Step 3: Add validation implementation**

Create `src/references/validation.ts`:

```typescript
import type { ReferenceCard } from './types.js';

export interface ReferenceCardValidationOptions {
  validTableNames?: Set<string>;
  validTeachingIds?: Set<string>;
  allowedDomains?: Set<string>;
}

export function validateReferenceCards(
  cards: ReferenceCard[],
  options: ReferenceCardValidationOptions = {},
): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const card of cards) {
    if (seenIds.has(card.id)) {
      errors.push(`Duplicate reference card id: ${card.id}`);
    }
    seenIds.add(card.id);

    if (!card.aliases.some(value => value.trim().length > 0)) {
      errors.push(`ReferenceCard ${card.id} must include at least one alias`);
    }

    if (!card.routing_triggers.some(value => value.trim().length > 0)) {
      errors.push(`ReferenceCard ${card.id} must include at least one routing trigger`);
    }

    if (!card.updated || !/^\d{4}-\d{2}-\d{2}$/.test(card.updated)) {
      errors.push(`ReferenceCard ${card.id} has invalid or missing updated date: ${card.updated}`);
    }

    if (options.allowedDomains && !options.allowedDomains.has(card.domain)) {
      errors.push(`ReferenceCard ${card.id} has unsupported domain: ${card.domain}`);
    }

    if (options.validTableNames && !options.validTableNames.has(card.canonical_table)) {
      errors.push(`ReferenceCard ${card.id} references unknown canonical_table: ${card.canonical_table}`);
    }

    if (options.validTableNames) {
      for (const table of card.avoid_tables) {
        if (!options.validTableNames.has(table)) {
          errors.push(`ReferenceCard ${card.id} references unknown avoid_table: ${table}`);
        }
      }
    }

    if (options.validTeachingIds) {
      for (const teachingId of card.related_teachings) {
        if (!options.validTeachingIds.has(teachingId)) {
          errors.push(`ReferenceCard ${card.id} references unknown related teaching: ${teachingId}`);
        }
      }
    }
  }

  return errors;
}
```

- [ ] **Step 4: Run validation tests**

Run:

```bash
npx vitest run tests/references/validation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/references/validation.ts tests/references/validation.test.ts
git commit -m "feat: validate reference cards"
```

---

## Task 3: Add ReferenceCard Markdown Conversion

**Files:**
- Create: `src/references/markdownConverter.ts`
- Create: `tests/references/markdownConverter.test.ts`

- [ ] **Step 1: Write the failing markdown converter tests**

Create `tests/references/markdownConverter.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { referenceCardToMarkdown } from '../../src/references/markdownConverter.js';
import type { ReferenceCard } from '../../src/references/types.js';

const card: ReferenceCard = {
  id: 'revenue-canonical-definition',
  title: 'Canonical Revenue Definition',
  domain: 'revenue',
  grain: 'order',
  canonical_table: 'analytics.fct_orders',
  canonical_metric: 'total_amount',
  required_filters: ["order_status = 'completed'"],
  exclusions: ['cancelled orders', 'refunded orders'],
  avoid_tables: ['analytics.fct_revenue'],
  aliases: ['revenue', 'sales'],
  routing_triggers: ['total revenue', 'revenue last month'],
  owner: 'finance-analytics',
  freshness_sla: 'refreshed daily after dbt build',
  related_teachings: ['revenue-monthly'],
  updated: '2026-06-04',
};

describe('referenceCardToMarkdown', () => {
  it('emits stable retrieval-friendly markdown', () => {
    const markdown = referenceCardToMarkdown(card);

    expect(markdown).toContain('# ReferenceCard: revenue-canonical-definition');
    expect(markdown).toContain('Title: Canonical Revenue Definition');
    expect(markdown).toContain('Domain: revenue');
    expect(markdown).toContain('Canonical table: analytics.fct_orders');
    expect(markdown).toContain('Canonical metric: total_amount');
    expect(markdown).toContain('- total revenue');
    expect(markdown).toContain("- order_status = 'completed'");
    expect(markdown).toContain('- analytics.fct_revenue');
    expect(markdown).toContain('- revenue-monthly');
  });
});
```

- [ ] **Step 2: Run markdown tests to verify they fail**

Run:

```bash
npx vitest run tests/references/markdownConverter.test.ts
```

Expected: FAIL with an import error for `src/references/markdownConverter.js`.

- [ ] **Step 3: Add markdown converter**

Create `src/references/markdownConverter.ts`:

```typescript
import type { ReferenceCard } from './types.js';

export function referenceCardToMarkdown(card: ReferenceCard): string {
  const lines: string[] = [
    `# ReferenceCard: ${card.id}`,
    `Title: ${card.title}`,
    `Domain: ${card.domain}`,
    `Owner: ${card.owner}`,
    `Updated: ${card.updated}`,
    `Canonical table: ${card.canonical_table}`,
    `Canonical metric: ${card.canonical_metric}`,
    `Grain: ${card.grain}`,
    `Freshness SLA: ${card.freshness_sla}`,
    '',
    '## Aliases',
    ...list(card.aliases),
    '',
    '## Routing Triggers',
    ...list(card.routing_triggers),
    '',
    '## Required Filters',
    ...list(card.required_filters),
    '',
    '## Exclusions',
    ...list(card.exclusions),
    '',
    '## Avoid Tables',
    ...list(card.avoid_tables),
    '',
    '## Related Teachings',
    ...list(card.related_teachings),
  ];

  return lines.join('\n');
}

function list(values: string[]): string[] {
  return values.length > 0 ? values.map(value => `- ${value}`) : ['- none'];
}
```

- [ ] **Step 4: Run markdown tests**

Run:

```bash
npx vitest run tests/references/markdownConverter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/references/markdownConverter.ts tests/references/markdownConverter.test.ts
git commit -m "feat: render reference cards for retrieval"
```

---

## Task 4: Add Revenue Reference Cards

**Files:**
- Create: `references/revenue.yml`
- Test: `tests/references/parser.test.ts`
- Test: `tests/references/validation.test.ts`

- [ ] **Step 1: Add a fixture-loading test for the revenue file**

Append to `tests/references/parser.test.ts`:

```typescript
import { readFileSync } from 'node:fs';
```

Add this test inside `describe('parseReferenceCardFile', () => { ... })`:

```typescript
  it('loads the checked-in revenue reference cards', () => {
    const yaml = readFileSync('references/revenue.yml', 'utf-8');
    const cards = parseReferenceCardFile(yaml);

    expect(cards.length).toBeGreaterThanOrEqual(5);
    expect(cards.length).toBeLessThanOrEqual(10);
    expect(cards.map(card => card.id)).toContain('revenue-canonical-definition');
  });
```

Append to `tests/references/validation.test.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { parseReferenceCardFile } from '../../src/references/parser.js';
```

Add this test inside `describe('validateReferenceCards', () => { ... })`:

```typescript
  it('accepts the checked-in revenue cards structurally', () => {
    const yaml = readFileSync('references/revenue.yml', 'utf-8');
    const cards = parseReferenceCardFile(yaml);
    const errors = validateReferenceCards(cards, {
      allowedDomains: new Set(['revenue']),
      validTeachingIds: new Set(['revenue-monthly']),
    });

    expect(errors).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail before the file exists**

Run:

```bash
npx vitest run tests/references/parser.test.ts tests/references/validation.test.ts
```

Expected: FAIL with `ENOENT: no such file or directory, open 'references/revenue.yml'`.

- [ ] **Step 3: Add `references/revenue.yml`**

Create `references/revenue.yml`:

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

  - id: revenue-monthly-grain
    title: Monthly Revenue Grain
    domain: revenue
    grain: calendar month
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    required_filters:
      - order_status = 'completed'
      - group by DATE_TRUNC(order_date, MONTH)
    exclusions:
      - ungrouped order-level rows for monthly questions
    avoid_tables:
      - analytics.fct_revenue
    aliases:
      - monthly revenue
      - revenue by month
      - MRR
    routing_triggers:
      - show monthly revenue
      - revenue by month
      - revenue this year by month
    owner: finance-analytics
    freshness_sla: refreshed daily after dbt build
    related_teachings:
      - revenue-monthly
    updated: "2026-06-04"

  - id: revenue-customer-lifetime-value
    title: Customer Lifetime Revenue
    domain: revenue
    grain: customer
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    required_filters:
      - order_status = 'completed'
      - join to analytics.dim_customers on customer_id when customer attributes are requested
    exclusions:
      - cancelled orders
      - refunded orders
    avoid_tables:
      - analytics.fct_revenue
    aliases:
      - lifetime value
      - LTV
      - top customers by revenue
    routing_triggers:
      - top customers by lifetime value
      - highest value customers
      - customer revenue ranking
    owner: finance-analytics
    freshness_sla: refreshed daily after dbt build
    related_teachings:
      - revenue-monthly
    updated: "2026-06-04"

  - id: revenue-refunds-exclusions
    title: Revenue Refund and Cancellation Exclusions
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    required_filters:
      - order_status = 'completed'
    exclusions:
      - order_status = 'cancelled'
      - order_status = 'refunded'
    avoid_tables:
      - analytics.fct_revenue
    aliases:
      - refunds
      - cancelled revenue
      - revenue exclusions
    routing_triggers:
      - should refunds count in revenue
      - exclude cancelled orders from revenue
      - revenue net of refunds
    owner: finance-analytics
    freshness_sla: refreshed daily after dbt build
    related_teachings:
      - revenue-monthly
    updated: "2026-06-04"

  - id: revenue-ambiguous-intake
    title: Ambiguous Revenue Intake
    domain: revenue
    grain: unresolved
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    required_filters:
      - ask for or infer a time period before running broad revenue SQL
    exclusions:
      - arbitrary all-time revenue when the user only says revenue
    avoid_tables:
      - analytics.fct_revenue
    aliases:
      - revenue
      - sales
    routing_triggers:
      - revenue
      - sales
    owner: finance-analytics
    freshness_sla: refreshed daily after dbt build
    related_teachings:
      - revenue-monthly
    updated: "2026-06-04"
```

- [ ] **Step 4: Run reference tests**

Run:

```bash
npx vitest run tests/references/parser.test.ts tests/references/validation.test.ts tests/references/markdownConverter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add references/revenue.yml tests/references/parser.test.ts tests/references/validation.test.ts
git commit -m "feat: add revenue reference cards"
```

---

## Task 5: Generalize File Search Sync to Markdown Documents

**Files:**
- Modify: `src/teachings/fileSearchSync.ts`
- Modify: `tests/teachings/fileSearchSync.test.ts`

- [ ] **Step 1: Add failing tests for generic markdown document sync**

Update imports in `tests/teachings/fileSearchSync.test.ts`:

```typescript
import { syncMarkdownDocumentsToFileSearch, syncTeachingsToFileSearch } from '../../src/teachings/fileSearchSync.js';
```

Update the File Search mock in the same test file so the cleanup path is available:

```typescript
const mockUpload = vi.fn();
const mockListFiles = vi.fn();
const mockDeleteFile = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return {
      fileSearchStores: {
        uploadToFileSearchStore: mockUpload,
        listFileSearchStoreFiles: mockListFiles,
        deleteFileSearchStoreFile: mockDeleteFile,
      },
    };
  }),
}));
```

Update `beforeEach` in the same test file:

```typescript
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpload.mockResolvedValue({ name: 'op-1', done: true });
    mockListFiles.mockResolvedValue([]);
    mockDeleteFile.mockResolvedValue({});
  });
```

Add this test inside `describe('syncTeachingsToFileSearch', () => { ... })`:

```typescript
  it('uploads generic markdown documents with explicit display names', async () => {
    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key');

    expect(result.uploaded).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        fileSearchStoreName: 'stores/test',
        config: expect.objectContaining({
          displayName: 'reference_card:revenue-canonical-definition',
        }),
      }),
    );
  });
```

Update the existing display-name test expectation:

```typescript
displayName: 'teaching:revenue-monthly',
```

- [ ] **Step 2: Run File Search sync tests to verify they fail**

Run:

```bash
npx vitest run tests/teachings/fileSearchSync.test.ts
```

Expected: FAIL because `syncMarkdownDocumentsToFileSearch` is not exported and teaching display names still use raw IDs.

- [ ] **Step 3: Replace `src/teachings/fileSearchSync.ts` with generic sync plus wrapper**

Use this implementation:

```typescript
import { GoogleGenAI } from '@google/genai';
import type { Teaching } from './types.js';
import { teachingToMarkdown } from './markdownConverter.js';

export interface SyncResult {
  uploaded: number;
  deleted: number;
  errors: string[];
}

export interface FileSearchDocument {
  id: string;
  displayName: string;
  markdown: string;
}

async function clearExistingFiles(
  ai: GoogleGenAI,
  fileSearchStoreName: string,
): Promise<number> {
  let deleted = 0;
  try {
    const stores = ai.fileSearchStores as any;
    const files = await stores.listFileSearchStoreFiles({ fileSearchStoreName });
    if (files && Array.isArray(files)) {
      for (const file of files) {
        try {
          await stores.deleteFileSearchStoreFile({
            fileSearchStoreName,
            fileSearchStoreFileName: file.name,
          });
          deleted++;
        } catch {
          // Best-effort cleanup; continue on individual file deletion failure.
        }
      }
    }
  } catch {
    // If listing/deletion fails, proceed with upload.
  }
  return deleted;
}

export async function syncMarkdownDocumentsToFileSearch(
  documents: FileSearchDocument[],
  fileSearchStoreName: string,
  apiKey: string,
): Promise<SyncResult> {
  const result: SyncResult = { uploaded: 0, deleted: 0, errors: [] };
  if (documents.length === 0) return result;

  const ai = new GoogleGenAI({ apiKey });
  result.deleted = await clearExistingFiles(ai, fileSearchStoreName);

  for (const document of documents) {
    try {
      const file = new Blob([document.markdown], { type: 'text/markdown' });

      await ai.fileSearchStores.uploadToFileSearchStore({
        fileSearchStoreName,
        file,
        config: {
          displayName: document.displayName,
        },
      });

      result.uploaded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${document.id}: ${msg}`);
    }
  }

  return result;
}

export async function syncTeachingsToFileSearch(
  teachings: Teaching[],
  fileSearchStoreName: string,
  apiKey: string,
): Promise<SyncResult> {
  return syncMarkdownDocumentsToFileSearch(
    teachings.map(teaching => ({
      id: teaching.id,
      displayName: `teaching:${teaching.id}`,
      markdown: teachingToMarkdown(teaching),
    })),
    fileSearchStoreName,
    apiKey,
  );
}
```

- [ ] **Step 4: Run File Search sync tests**

Run:

```bash
npx vitest run tests/teachings/fileSearchSync.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/teachings/fileSearchSync.ts tests/teachings/fileSearchSync.test.ts
git commit -m "feat: support generic knowledge file search sync"
```

---

## Task 6: Add Knowledge Validation and Sync Scripts

**Files:**
- Create: `scripts/knowledgeSupport.ts`
- Create: `scripts/validate-knowledge.ts`
- Create: `scripts/sync-knowledge.ts`
- Create: `tests/scripts/knowledgeSupport.test.ts`
- Modify: `.github/workflows/sync-teachings.yml`

- [ ] **Step 1: Write failing knowledge support tests**

Create `tests/scripts/knowledgeSupport.test.ts`:

```typescript
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeDocuments,
  loadReferenceCardsFromDir,
  validateKnowledgeForSync,
} from '../../scripts/knowledgeSupport.js';
import type { Teaching } from '../../src/teachings/types.js';
import type { ReferenceCard } from '../../src/references/types.js';

function teaching(): Teaching {
  return {
    id: 'revenue-monthly',
    question_patterns: ['monthly revenue'],
    sanctioned_sql: null,
    reasoning: 'Use completed orders.',
    models_referenced: ['analytics.fct_orders'],
    tags: ['revenue'],
    author: 'finance',
    updated: '2026-06-04',
  };
}

function card(): ReferenceCard {
  return {
    id: 'revenue-canonical-definition',
    title: 'Canonical Revenue Definition',
    domain: 'revenue',
    grain: 'order',
    canonical_table: 'analytics.fct_orders',
    canonical_metric: 'total_amount',
    required_filters: ["order_status = 'completed'"],
    exclusions: ['cancelled orders'],
    avoid_tables: [],
    aliases: ['revenue'],
    routing_triggers: ['total revenue'],
    owner: 'finance-analytics',
    freshness_sla: 'daily',
    related_teachings: ['revenue-monthly'],
    updated: '2026-06-04',
  };
}

describe('loadReferenceCardsFromDir', () => {
  it('treats a missing references directory as empty', async () => {
    await expect(loadReferenceCardsFromDir('/tmp/annalytics-missing-references')).resolves.toEqual([]);
  });

  it('loads YAML reference cards from a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-references-'));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'revenue.yml'), `
reference_cards:
  - id: revenue-canonical-definition
    title: Canonical Revenue Definition
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    aliases: [revenue]
    routing_triggers: [total revenue]
    owner: finance-analytics
    freshness_sla: daily
    updated: "2026-06-04"
`);

    const cards = await loadReferenceCardsFromDir(root);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('revenue-canonical-definition');
  });
});

describe('buildKnowledgeDocuments', () => {
  it('builds teaching and reference-card documents with namespaced display names', () => {
    const documents = buildKnowledgeDocuments([teaching()], [card()]);

    expect(documents.map(doc => doc.displayName)).toEqual([
      'teaching:revenue-monthly',
      'reference_card:revenue-canonical-definition',
    ]);
    expect(documents[1].markdown).toContain('# ReferenceCard: revenue-canonical-definition');
  });
});

describe('validateKnowledgeForSync', () => {
  it('validates teachings and references without dbt artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annalytics-knowledge-'));
    await mkdir(join(root, 'teachings'), { recursive: true });
    await mkdir(join(root, 'references'), { recursive: true });
    await writeFile(join(root, 'teachings', 'revenue.yml'), `
teachings:
  - id: revenue-monthly
    question_patterns: [monthly revenue]
    sanctioned_sql: null
    reasoning: Use completed orders.
    models_referenced: [analytics.fct_orders]
    tags: [revenue]
    author: finance
    updated: "2026-06-04"
`);
    await writeFile(join(root, 'references', 'revenue.yml'), `
reference_cards:
  - id: revenue-canonical-definition
    title: Canonical Revenue Definition
    domain: revenue
    grain: order
    canonical_table: analytics.fct_orders
    canonical_metric: total_amount
    aliases: [revenue]
    routing_triggers: [total revenue]
    owner: finance-analytics
    freshness_sla: daily
    related_teachings: [revenue-monthly]
    updated: "2026-06-04"
`);

    await expect(validateKnowledgeForSync(root)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run knowledge support tests to verify they fail**

Run:

```bash
npx vitest run tests/scripts/knowledgeSupport.test.ts
```

Expected: FAIL with an import error for `scripts/knowledgeSupport.js`.

- [ ] **Step 3: Add `scripts/knowledgeSupport.ts`**

Create `scripts/knowledgeSupport.ts`:

```typescript
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTeachingFile } from '../src/teachings/parser.js';
import { teachingToMarkdown } from '../src/teachings/markdownConverter.js';
import { loadDbtTableNames, validateTeachingIntegrity } from '../src/teachings/validation.js';
import type { Teaching } from '../src/teachings/types.js';
import { parseReferenceCardFile } from '../src/references/parser.js';
import { referenceCardToMarkdown } from '../src/references/markdownConverter.js';
import { validateReferenceCards } from '../src/references/validation.js';
import type { ReferenceCard } from '../src/references/types.js';
import type { FileSearchDocument } from '../src/teachings/fileSearchSync.js';
import { initBigQuery, dryRunValidation } from '../src/validation/dryRun.js';

export async function loadTeachingsFromDir(teachingsDir: string): Promise<Teaching[]> {
  const files = await listYamlFilesOrEmpty(teachingsDir);
  const teachings: Teaching[] = [];

  for (const file of files) {
    const content = await readFile(join(teachingsDir, file), 'utf-8');
    teachings.push(...parseTeachingFile(content));
  }

  return teachings;
}

export async function loadReferenceCardsFromDir(referencesDir: string): Promise<ReferenceCard[]> {
  const files = await listYamlFilesOrEmpty(referencesDir);
  const cards: ReferenceCard[] = [];

  for (const file of files) {
    const content = await readFile(join(referencesDir, file), 'utf-8');
    cards.push(...parseReferenceCardFile(content));
  }

  return cards;
}

export function buildKnowledgeDocuments(
  teachings: Teaching[],
  referenceCards: ReferenceCard[],
): FileSearchDocument[] {
  return [
    ...teachings.map(teaching => ({
      id: teaching.id,
      displayName: `teaching:${teaching.id}`,
      markdown: teachingToMarkdown(teaching),
    })),
    ...referenceCards.map(card => ({
      id: card.id,
      displayName: `reference_card:${card.id}`,
      markdown: referenceCardToMarkdown(card),
    })),
  ];
}

export async function validateKnowledgeForSync(rootDir = process.cwd()): Promise<string[]> {
  const teachings = await loadTeachingsFromDir(join(rootDir, 'teachings'));
  const referenceCards = await loadReferenceCardsFromDir(join(rootDir, 'references'));
  if (teachings.length === 0 && referenceCards.length === 0) return [];

  const validTableNames = await loadDbtTableNames(rootDir);
  const teachingErrors = validateTeachingIntegrity(teachings, {
    validTableNames: validTableNames ?? undefined,
  });
  const referenceErrors = validateReferenceCards(referenceCards, {
    validTableNames: validTableNames ?? undefined,
    validTeachingIds: teachings.length > 0 ? new Set(teachings.map(t => t.id)) : undefined,
    allowedDomains: new Set(['revenue']),
  });
  const errors = [...teachingErrors, ...referenceErrors];

  const projectId = process.env.GCP_PROJECT_ID;
  if (projectId) {
    initBigQuery(projectId);
    for (const teaching of teachings) {
      if (!teaching.sanctioned_sql) continue;
      const result = await dryRunValidation(teaching.sanctioned_sql);
      if (!result.valid) {
        errors.push(`Teaching ${teaching.id} sanctioned_sql failed dry run: ${result.error}`);
      }
    }
  }

  return errors;
}

async function listYamlFilesOrEmpty(dir: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    return files.filter(file => file.endsWith('.yml') || file.endsWith('.yaml'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
```

- [ ] **Step 4: Add validation CLI**

Create `scripts/validate-knowledge.ts`:

```typescript
import { validateKnowledgeForSync } from './knowledgeSupport.js';

async function main() {
  const errors = await validateKnowledgeForSync();
  if (errors.length > 0) {
    console.error('Knowledge validation failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  console.log('Knowledge validation passed');
}

if (process.argv[1]?.endsWith('validate-knowledge.ts') || process.argv[1]?.endsWith('validate-knowledge.js')) {
  main().catch(err => {
    console.error('Knowledge validation failed:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Add sync CLI**

Create `scripts/sync-knowledge.ts`:

```typescript
import { buildSummaries } from '../src/teachings/summaryMap.js';
import { initFirestore, getDb } from '../src/state/firestore.js';
import { syncMarkdownDocumentsToFileSearch } from '../src/teachings/fileSearchSync.js';
import {
  buildKnowledgeDocuments,
  loadReferenceCardsFromDir,
  loadTeachingsFromDir,
  validateKnowledgeForSync,
} from './knowledgeSupport.js';

async function main() {
  const errors = await validateKnowledgeForSync();
  if (errors.length > 0) {
    console.error('Knowledge validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  const teachings = await loadTeachingsFromDir('teachings');
  const referenceCards = await loadReferenceCardsFromDir('references');
  const documents = buildKnowledgeDocuments(teachings, referenceCards);
  if (documents.length === 0) {
    console.log('No knowledge files found');
    return;
  }

  const storeId = process.env.FILE_SEARCH_STORE_ID;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!storeId || !apiKey) {
    throw new Error('Missing FILE_SEARCH_STORE_ID or GEMINI_API_KEY');
  }

  const result = await syncMarkdownDocumentsToFileSearch(documents, storeId, apiKey);
  console.log(`Uploaded: ${result.uploaded}, Errors: ${result.errors.length}`);
  if (result.errors.length > 0) {
    console.error('Sync errors:', result.errors);
    process.exit(1);
  }

  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error('Missing GCP_PROJECT_ID');
  }
  initFirestore(projectId);
  const db = getDb();
  const summaries = buildSummaries(teachings);
  await db.doc('config/teaching_summaries').set({
    summaries,
    lastUpdatedAt: new Date(),
  });
  console.log(`Updated teaching summary map: ${summaries.length} entries`);
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Knowledge sync failed:', err);
  process.exit(1);
});
```

- [ ] **Step 6: Update workflow path filters and commands**

Modify `.github/workflows/sync-teachings.yml`:

```yaml
name: Sync Teachings
on:
  push:
    branches: [main]
    paths:
      - 'teachings/**/*.yml'
      - 'teachings/**/*.yaml'
      - 'references/**/*.yml'
      - 'references/**/*.yaml'
      - 'src/teachings/**'
      - 'src/references/**'
      - 'scripts/knowledgeSupport.ts'
      - 'scripts/validate-knowledge.ts'
      - 'scripts/sync-knowledge.ts'

jobs:
  sync:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4

      - id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
          service_account: ${{ secrets.WIF_SERVICE_ACCOUNT }}

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - name: Validate knowledge
        env:
          GCP_PROJECT_ID: ${{ secrets.GCP_PROJECT_ID }}
        run: npx tsx scripts/validate-knowledge.ts

      - name: Sync knowledge to File Search
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY_CI }}
          FILE_SEARCH_STORE_ID: ${{ secrets.FILE_SEARCH_STORE_ID }}
          GCP_PROJECT_ID: ${{ secrets.GCP_PROJECT_ID }}
        run: npx tsx scripts/sync-knowledge.ts
```

- [ ] **Step 7: Run knowledge tests and CLI**

Run:

```bash
npx vitest run tests/scripts/knowledgeSupport.test.ts
npx tsx scripts/validate-knowledge.ts
```

Expected: both PASS. The CLI prints `Knowledge validation passed`.

- [ ] **Step 8: Commit Task 6**

```bash
git add scripts/knowledgeSupport.ts scripts/validate-knowledge.ts scripts/sync-knowledge.ts tests/scripts/knowledgeSupport.test.ts .github/workflows/sync-teachings.yml
git commit -m "feat: validate and sync knowledge files"
```

---

## Task 7: Update SQL Generator Knowledge Context Wording

**Files:**
- Modify: `src/agents/sqlGenerator.ts`
- Modify: `tests/agents/sqlGenerator.filesearch.test.ts`

- [ ] **Step 1: Add failing prompt wording test**

Append to `tests/agents/sqlGenerator.filesearch.test.ts` inside `describe('generateSql — File Search integration', () => { ... })`:

```typescript
  it('describes File Search as teachings plus reference cards', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(baseResponse),
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    });

    await generateSql({
      question: 'revenue?',
      tables: [mockTable],
      threadContext: [],
      apiKey: 'key',
      fileSearchStoreId: 'stores/my-store',
    });

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.systemInstruction).toContain('KNOWLEDGE CONTEXT');
    expect(call.config.systemInstruction).toContain('teachings');
    expect(call.config.systemInstruction).toContain('reference cards');
  });
```

- [ ] **Step 2: Run SQL generator File Search tests to verify they fail**

Run:

```bash
npx vitest run tests/agents/sqlGenerator.filesearch.test.ts
```

Expected: FAIL because the prompt still says `TEACHINGS`.

- [ ] **Step 3: Update File Search prompt block**

In `src/agents/sqlGenerator.ts`, replace the existing File Search context block:

```typescript
  if (opts.fileSearchStoreId) {
    prompt += `\nTEACHINGS:
(Relevant teachings are automatically retrieved via Gemini File Search.
Follow sanctioned SQL patterns when they exist for the question type.)\n`;
  }
```

with:

```typescript
  if (opts.fileSearchStoreId) {
    prompt += `\nKNOWLEDGE CONTEXT:
Relevant teachings and reference cards are automatically retrieved via Gemini File Search.
Follow sanctioned SQL patterns from teachings when they exist.
Follow reference-card constraints for canonical tables, metrics, grains, required filters, exclusions, and avoid-table guidance when they apply.\n`;
  }
```

- [ ] **Step 4: Run SQL generator File Search tests**

Run:

```bash
npx vitest run tests/agents/sqlGenerator.filesearch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 7**

```bash
git add src/agents/sqlGenerator.ts tests/agents/sqlGenerator.filesearch.test.ts
git commit -m "feat: include reference cards in sql knowledge prompt"
```

---

## Task 8: Add Benchmark Reference Retrieval Helpers and Types

**Files:**
- Modify: `scripts/benchmark-types.ts`
- Modify: `scripts/benchmarkSupport.ts`
- Modify: `tests/scripts/benchmarkSupport.test.ts`

- [ ] **Step 1: Add failing benchmark helper tests**

Update imports in `tests/scripts/benchmarkSupport.test.ts`:

```typescript
import {
  buildBenchmarkMetadata,
  extractReferenceIdsFromCitations,
  referenceRetrievalPassed,
  validationResultsFromFailures,
} from '../../scripts/benchmarkSupport.js';
```

Append:

```typescript
describe('reference retrieval helpers', () => {
  it('extracts reference IDs from source names and chunk text', () => {
    const ids = extractReferenceIdsFromCitations([
      {
        sourceFile: 'reference_card:revenue-canonical-definition',
        chunkText: 'Canonical table: analytics.fct_orders',
        relevanceScore: 1,
      },
      {
        sourceFile: 'file-123',
        chunkText: '# ReferenceCard: revenue-monthly-grain\nDomain: revenue',
        relevanceScore: 1,
      },
    ]);

    expect(ids).toEqual([
      'revenue-canonical-definition',
      'revenue-monthly-grain',
    ]);
  });

  it('reports whether all expected reference IDs were observed', () => {
    expect(referenceRetrievalPassed(
      ['revenue-canonical-definition'],
      ['revenue-canonical-definition', 'revenue-monthly-grain'],
    )).toBe(true);

    expect(referenceRetrievalPassed(
      ['revenue-canonical-definition', 'revenue-monthly-grain'],
      ['revenue-canonical-definition'],
    )).toBe(false);

    expect(referenceRetrievalPassed(undefined, [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run benchmark support tests to verify they fail**

Run:

```bash
npx vitest run tests/scripts/benchmarkSupport.test.ts
```

Expected: FAIL because the helper exports do not exist.

- [ ] **Step 3: Extend benchmark types**

In `scripts/benchmark-types.ts`, update `CorpusEntry`:

```typescript
  expectedReferenceIds?: string[];
```

Update `BenchmarkResult`:

```typescript
  expectedReferenceIds?: string[];
  observedReferenceIds: string[];
  referenceRetrievalPassed: boolean | null;
```

- [ ] **Step 4: Add helper implementations**

Append to `scripts/benchmarkSupport.ts`:

```typescript
import type { GroundingCitation } from '../src/agents/types.js';
```

Add these exports:

```typescript
export function extractReferenceIdsFromCitations(
  citations: Pick<GroundingCitation, 'sourceFile' | 'chunkText' | 'relevanceScore'>[],
): string[] {
  const ids = new Set<string>();
  for (const citation of citations) {
    const sourceMatch = citation.sourceFile.match(/reference_card:([a-z0-9-]+)/i);
    if (sourceMatch) ids.add(sourceMatch[1]);

    const chunkMatch = citation.chunkText.match(/ReferenceCard:\s*([a-z0-9-]+)/i);
    if (chunkMatch) ids.add(chunkMatch[1]);
  }
  return [...ids].sort();
}

export function referenceRetrievalPassed(
  expectedReferenceIds: string[] | undefined,
  observedReferenceIds: string[],
): boolean | null {
  if (!expectedReferenceIds || expectedReferenceIds.length === 0) return null;
  const observed = new Set(observedReferenceIds);
  return expectedReferenceIds.every(id => observed.has(id));
}
```

Place the new `GroundingCitation` import with the existing imports at the top of the file.

- [ ] **Step 5: Run benchmark support tests**

Run:

```bash
npx vitest run tests/scripts/benchmarkSupport.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```bash
git add scripts/benchmark-types.ts scripts/benchmarkSupport.ts tests/scripts/benchmarkSupport.test.ts
git commit -m "feat: track reference card retrieval in benchmarks"
```

---

## Task 9: Record Reference Retrieval in Benchmark Runs and Corpus

**Files:**
- Modify: `scripts/benchmark.ts`
- Modify: `benchmarks/corpus.json`
- Modify: `tests/scripts/benchmark.test.ts`

- [ ] **Step 1: Add failing corpus and deterministic retrieval assertions**

Add this import to `tests/scripts/benchmark.test.ts`:

```typescript
import { referenceRetrievalPassed } from '../../scripts/benchmarkSupport.js';
```

Append to `tests/scripts/benchmark.test.ts` inside `describe('benchmark corpus', () => { ... })`:

```typescript
  it('contains revenue reference-card benchmark cases', () => {
    const raw = readFileSync('benchmarks/corpus.json', 'utf-8');
    const corpus: CorpusEntry[] = JSON.parse(raw);
    const revenueCases = corpus.filter(entry => entry.expectedReferenceIds?.length);

    expect(revenueCases.length).toBeGreaterThanOrEqual(4);
    expect(revenueCases.map(entry => entry.id)).toContain('revenue-ref-001');
    expect(revenueCases.flatMap(entry => entry.expectedReferenceIds ?? [])).toContain('revenue-canonical-definition');
  });

  it('deterministically checks reference retrieval expectations for the revenue seed case', () => {
    const raw = readFileSync('benchmarks/corpus.json', 'utf-8');
    const corpus: CorpusEntry[] = JSON.parse(raw);
    const entry = corpus.find(item => item.id === 'revenue-ref-001');

    expect(entry?.expectedReferenceIds).toEqual(['revenue-canonical-definition']);
    expect(referenceRetrievalPassed(
      entry?.expectedReferenceIds,
      ['revenue-canonical-definition'],
    )).toBe(true);
    expect(referenceRetrievalPassed(
      entry?.expectedReferenceIds,
      [],
    )).toBe(false);
  });
```

- [ ] **Step 2: Run corpus tests to verify they fail**

Run:

```bash
npx vitest run tests/scripts/benchmark.test.ts
```

Expected: FAIL because no entries have `expectedReferenceIds`.

- [ ] **Step 3: Update `benchmarks/corpus.json`**

Add these entries after the existing seed entries:

```json
  {
    "id": "revenue-ref-001",
    "question": "What was total revenue last month?",
    "category": "simple",
    "source": "manual",
    "expectedTables": ["analytics.fct_orders"],
    "expectedReferenceIds": ["revenue-canonical-definition"],
    "notes": "ReferenceCard should force completed-order revenue definition"
  },
  {
    "id": "revenue-ref-002",
    "question": "Show monthly revenue this year",
    "category": "time_series",
    "source": "manual",
    "expectedTables": ["analytics.fct_orders"],
    "expectedReferenceIds": ["revenue-monthly-grain"],
    "notes": "ReferenceCard should force DATE_TRUNC month grain"
  },
  {
    "id": "revenue-ref-003",
    "question": "Top 10 customers by lifetime value",
    "category": "aggregate",
    "source": "manual",
    "expectedTables": ["analytics.fct_orders", "analytics.dim_customers"],
    "expectedReferenceIds": ["revenue-customer-lifetime-value"],
    "notes": "ReferenceCard should guide customer-level revenue aggregation"
  },
  {
    "id": "revenue-ref-004",
    "question": "Should refunds count in revenue?",
    "category": "edge_case",
    "source": "manual",
    "expectedTables": ["analytics.fct_orders"],
    "expectedReferenceIds": ["revenue-refunds-exclusions"],
    "notes": "ReferenceCard should retrieve refund and cancellation exclusions"
  },
  {
    "id": "revenue-ref-005",
    "question": "revenue",
    "category": "ambiguous",
    "source": "manual",
    "expectedTables": ["analytics.fct_orders"],
    "expectedReferenceIds": ["revenue-ambiguous-intake"],
    "notes": "ReferenceCard should discourage arbitrary all-time revenue SQL"
  }
```

Keep the JSON array valid by adding commas between entries and no trailing comma after the final entry.

- [ ] **Step 4: Update `scripts/benchmark.ts` imports and result construction**

Add imports from `scripts/benchmarkSupport.ts`:

```typescript
  extractReferenceIdsFromCitations,
  referenceRetrievalPassed,
```

In the low-clarification result object, add:

```typescript
          expectedReferenceIds: entry.expectedReferenceIds,
          observedReferenceIds: [],
          referenceRetrievalPassed: referenceRetrievalPassed(entry.expectedReferenceIds, []),
```

In the quality-loop result path, compute observed IDs before building `result`:

```typescript
      const observedReferenceIds = extractReferenceIdsFromCitations(
        quality.sqlResult.groundingCitations,
      );
```

Then add to the `BenchmarkResult` object:

```typescript
        expectedReferenceIds: entry.expectedReferenceIds,
        observedReferenceIds,
        referenceRetrievalPassed: referenceRetrievalPassed(
          entry.expectedReferenceIds,
          observedReferenceIds,
        ),
```

In the catch/error result object, add:

```typescript
        expectedReferenceIds: entry.expectedReferenceIds,
        observedReferenceIds: [],
        referenceRetrievalPassed: referenceRetrievalPassed(entry.expectedReferenceIds, []),
```

- [ ] **Step 5: Run benchmark tests**

Run:

```bash
npx vitest run tests/scripts/benchmark.test.ts tests/scripts/benchmarkSupport.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 9**

```bash
git add scripts/benchmark.ts benchmarks/corpus.json tests/scripts/benchmark.test.ts
git commit -m "feat: add reference card benchmark cases"
```

---

## Task 10: Final Governance Update and Verification

**Files:**
- Modify: `docs/trajectory-governance.md`

- [ ] **Step 1: Update governance implementation notes**

In `docs/trajectory-governance.md`, under `Current Implementation Notes`, add:

```markdown
- The Revenue ReferenceCard v1 Trust Tranche is implemented by `references/revenue.yml`, `src/references/`, knowledge sync scripts, and benchmark reference-card retrieval fields.
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npx vitest run tests/references/parser.test.ts tests/references/validation.test.ts tests/references/markdownConverter.test.ts tests/scripts/knowledgeSupport.test.ts tests/teachings/fileSearchSync.test.ts tests/agents/sqlGenerator.filesearch.test.ts tests/scripts/benchmark.test.ts tests/scripts/benchmarkSupport.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run validation CLI**

Run:

```bash
npx tsx scripts/validate-knowledge.ts
```

Expected: prints `Knowledge validation passed`.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm run typecheck
npm test
npm run lint
npm run build
git diff --check
```

Expected:

- `npm run typecheck`: exits 0.
- `npm test`: exits 0.
- `npm run lint`: exits 0. Existing warnings are acceptable if no errors are introduced.
- `npm run build`: exits 0.
- `git diff --check`: exits 0.

- [ ] **Step 5: Commit Task 10**

```bash
git add docs/trajectory-governance.md
git commit -m "docs: record reference card tranche implementation"
```

---

## Execution Notes

- Do not add a new Slack UI in this tranche.
- Do not add a domain router or domain agent.
- Do not create a second File Search store.
- Keep dbt artifact checks optional when artifacts are absent.
- Keep BigQuery dry-run checks conditional on `GCP_PROJECT_ID`.
- Preserve `syncTeachingsToFileSearch` compatibility for existing tests and scripts.
- Preserve File Search degradation behavior in `generateSql`.
