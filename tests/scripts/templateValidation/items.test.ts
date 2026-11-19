import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  hashItemInput,
  hashValidationSet,
  loadFixture,
  loadItems,
  scanTemplateSafety,
} from '../../../scripts/template-validation/items.js';
import { TV_ROOT } from '../../../scripts/template-validation/warehouse.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tv-items-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

it.each(['{', '{}'])('reports the line of a malformed item (%s)', (line) => {
  const first = readFileSync(join(TV_ROOT, 'items/slackIntake.jsonl'), 'utf8').split('\n')[0];
  write('items/slackIntake.jsonl', first + '\n\n' + line);
  expect(() => loadItems('slackIntake', root)).toThrow(/slackIntake\.jsonl:3/);
});

it('flags email addresses, foreign table references and GCP resource names', () => {
  const violations = scanTemplateSafety('a@b.com `acme-prod.analytics.orders` projects/acme-prod/datasets');
  for (const match of ['a@b.com', 'acme-prod.analytics.orders', 'projects/acme-prod']) {
    expect(violations.some((violation) => violation.includes(match))).toBe(true);
  }
});

it('allows references to the template view and public source', () => {
  expect(scanTemplateSafety('tv_thelook.orders `bigquery-public-data.thelook_ecommerce.orders`')).toEqual([]);
});

it.each([
  ['FROM tv_thelook.orders, private_dataset.customers', 'private_dataset.customers'],
  ['FROM tv_thelook.orders o, tv_thelook.users u LEFT JOIN private_dataset.customers c ON c.id = u.id', 'private_dataset.customers'],
  ['FROM (SELECT * FROM tv_thelook.orders) AS o, private_dataset.customers WHERE TRUE', 'private_dataset.customers'],
  ['FROM tv_thelook.orders o JOIN tv_thelook.users u ON u.name = "Example", private_dataset.customers', 'private_dataset.customers'],
  [JSON.stringify({ sql: 'SELECT * FROM tv_thelook.orders -- comment\n, private_dataset.customers' }), 'private_dataset.customers'],
  ['SELECT * FROM tv_thelook.orders AS o INNER JOIN o.shipping_address.city AS c ON TRUE', 'o.shipping_address.city'],
  ['SELECT `o.shipping_address.city` FROM tv_thelook.orders o', 'o.shipping_address.city'],
  ['Use `private_dataset.customers`', 'private_dataset.customers'],
  ['Use acme-prod.analytics.orders', 'acme-prod.analytics.orders'],
  ['An undeclared x.y.z in prose', 'x.y.z'],
])('flags the foreign reference in %s', (input, reference) => {
  expect(scanTemplateSafety(input)).toContain(`Foreign table reference: ${reference}`);
});

it.each(['o', 'AS o'])('allows a nested field path through an alias declared with %s', (alias) => {
  expect(scanTemplateSafety(`FROM tv_thelook.orders ${alias} WHERE o.shipping_address.city = 'Paris'`)).toEqual([]);
});

it('hashes nested input keys canonically and ignores labels and provenance', () => {
  const input = { thread: [{ role: 'user', content: 'question' }], message: 'why?' };
  expect(hashItemInput({
    message: 'why?',
    thread: [{ content: 'question', role: 'user' }],
    expectedIntent: 'meta_question',
    id: 'example',
    category: 'simple',
    agreement: { members: ['manual'] },
    source: 'manual',
    inputHash: 'unused',
  })).toBe(hashItemInput(input));
  expect(hashItemInput({ ...input, message: 'when?' })).not.toBe(hashItemInput(input));
});

it('hashes item bytes and ignores quarantine and cache files', () => {
  write('VERSION', 'tv-v1\n');
  write('items/slackIntake.jsonl', '{}\n');
  const original = hashValidationSet(root);
  write('quarantine/held.jsonl', 'held');
  write('.cache/cached.json', 'cached');
  expect(hashValidationSet(root)).toBe(original);
  write('items/slackIntake.jsonl', '{} \n');
  expect(hashValidationSet(root)).not.toBe(original);
});

it.each(['VERSION', 'knowledge/references/example.md', 'fixtures/example.json', 'dbt/manifest.json'])(
  'includes bytes from %s in the set hash',
  (path) => {
    write('VERSION', 'tv-v1\n');
    write(path, 'original');
    const original = hashValidationSet(root);
    write(path, 'changed');
    expect(hashValidationSet(root)).not.toBe(original);
  },
);

it('loads JSON fixtures by name from the supplied root', () => {
  write('fixtures/history.json', '{"runs":[]}');
  expect(loadFixture('history', root)).toEqual({ runs: [] });
  expect(loadFixture('history.json', root)).toEqual({ runs: [] });
  expect(() => loadFixture('../history', root)).toThrow(/fixture name/i);
});

it.each([
  ['slackIntake', 14],
  ['followUpClassifier', 12],
] as const)('loads all %s seeds with stable hashes and manual provenance', (node, count) => {
  const items = loadItems(node);
  expect(items).toHaveLength(count);
  expect(new Set(items.map((item) => item.id)).size).toBe(count);
  for (const item of items) {
    expect(item.source).toBe('manual');
    expect(item.agreement).toEqual({ members: ['manual'] });
    expect(item.inputHash).toBe(hashItemInput(item));
  }
  expect(scanTemplateSafety(readFileSync(join(TV_ROOT, 'items', node + '.jsonl'), 'utf8'))).toEqual([]);
});
