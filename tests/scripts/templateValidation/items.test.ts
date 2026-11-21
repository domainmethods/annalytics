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
  expect(scanTemplateSafety('`bigquery-public-data`.`thelook_ecommerce`.orders')).toEqual([]);
});

it.each([
  ['a@b.com', 'Email address: a@b.com'],
  ['projects/my-proj', 'GCP resource: projects/my-proj'],
])('flags %s', (text, violation) => {
  expect(scanTemplateSafety(text)).toContain(violation);
});

it.each([
  ['FROM tv_thelook.orders, private_dataset.customers', 'private_dataset.customers'],
  ['SELECT * FROM tv_thelook.orders, (private_dataset.customers RIGHT JOIN tv_thelook.users ON TRUE)', 'private_dataset.customers'],
  ['SELECT * FROM tv_thelook.orders JOIN (private_dataset.customers JOIN tv_thelook.users ON TRUE) ON TRUE', 'private_dataset.customers'],
  ['FROM (private_dataset.customers JOIN tv_thelook.users ON TRUE)', 'private_dataset.customers'],
  ['SELECT o.shipping_address.city FROM tv_thelook.orders /* note */ AS o', 'o.shipping_address.city'],
  ['The data from tv_thelook.orders arrives daily. Compare it to arrives.analytics.orders.', 'arrives.analytics.orders'],
  ['Use `private_dataset` . customers', 'private_dataset.customers'],
  ['Use acme /* note */ . analytics . `orders`', 'analytics.orders'],
  ['Use acme /* note */ . `analytics` . orders', 'acme.analytics.orders'],
  ['FROM private_dataset./* note */customers', 'private_dataset.customers'],
  ['Use tv_thelook./* acme.analytics.orders */orders', 'acme.analytics.orders'],
  ['Use tv_thelook./* FROM private_dataset.customers */orders', 'private_dataset.customers'],
  [JSON.stringify({ sql: 'SELECT * FROM tv_thelook.\n-- FROM private_dataset.customers\norders' }), 'private_dataset.customers'],
  [JSON.stringify({ sql: 'SELECT * FROM tv_thelook.\n/* FROM private_dataset.customers */\norders' }), 'private_dataset.customers'],
  [JSON.stringify({ sql: 'SELECT a.\n-- FROM private_dataset.customers\nb' }), 'private_dataset.customers'],
  [JSON.stringify({ sql: 'SELECT a.\n/* FROM private_dataset.customers */\nb' }), 'private_dataset.customers'],
  ['Use acme.analytics.2020', 'acme.analytics.2020'],
  ['FROM tv_thelook.orders--note: WHERE clause follows later\n, private_dataset.customers', 'private_dataset.customers'],
  ['FROM tv_thelook.orders o, tv_thelook.users u LEFT JOIN private_dataset.customers c ON c.id = u.id', 'private_dataset.customers'],
  ['FROM (SELECT * FROM tv_thelook.orders) AS o, private_dataset.customers WHERE TRUE', 'private_dataset.customers'],
  ['FROM tv_thelook.orders o JOIN tv_thelook.users u ON u.name = "Example", private_dataset.customers', 'private_dataset.customers'],
  [`FROM tv_thelook.orders o JOIN tv_thelook.users u ON u.name = '"#1', private_dataset.customers`, 'private_dataset.customers'],
  [`FROM tv_thelook.orders o JOIN tv_thelook.users u ON u.name = "'--", private_dataset.customers`, 'private_dataset.customers'],
  [String.raw`SELECT * FROM tv_thelook.orders o JOIN tv_thelook.users u ON o.name = \"#1\", private_dataset.customers`, 'private_dataset.customers'],
  [String.raw`FROM tv_thelook.orders o JOIN tv_thelook.users u ON o.name = \"item \\\"#1\", private_dataset.customers`, 'private_dataset.customers'],
  [String.raw`SELECT * FROM tv_thelook.orders o JOIN tv_thelook.users u ON o.name = 'it\\'s #1', private_dataset.customers`, 'private_dataset.customers'],
  [String.raw`FROM tv_thelook.orders o JOIN tv_thelook.users u ON o.name = 'it\'s #1' AND u.name = 'it\\'s #2', private_dataset.customers`, 'private_dataset.customers'],
  [String.raw`FROM tv_thelook.orders o JOIN tv_thelook.users u ON o.name = 'path\\', private_dataset.customers c JOIN tv_thelook.users v ON v.name = 'x'`, 'private_dataset.customers'],
  ['FROM tv_thelook.orders o JOIN tv_thelook.users u ON o.name = """unfinished\n, private_dataset.customers', 'private_dataset.customers'],
  [JSON.stringify({ sql: 'SELECT * FROM tv_thelook.orders -- comment\n, private_dataset.customers' }), 'private_dataset.customers'],
  ['SELECT * FROM tv_thelook.orders AS o INNER JOIN o.shipping_address.city AS c ON TRUE', 'o.shipping_address.city'],
  ['SELECT `o.shipping_address.city` FROM tv_thelook.orders o', 'o.shipping_address.city'],
  ['Use `private_dataset.customers`', 'private_dataset.customers'],
  ['Use ``private_dataset.customers`` for orders.', 'private_dataset.customers'],
  ['Use ``private_dataset . customers`` for orders.', 'private_dataset.customers'],
  ['Use `` `private_dataset.customers` `` for orders.', 'private_dataset.customers'],
  ['Use `` `private_dataset` `` . customers for orders.', 'private_dataset.customers'],
  ['Use ``SELECT * FROM private_dataset.customers`` for orders.', 'private_dataset.customers'],
  ['Use ``SELECT*FROM(private_dataset.customers)`` for orders.', 'private_dataset.customers'],
  ['SELECT EXTRACT(YEAR FROM u.created_at) FROM private_dataset.customers u', 'private_dataset.customers'],
  ['SELECT EXTRACT(YEAR FROM (SELECT MAX(x) FROM private_dataset.customers))', 'private_dataset.customers'],
  ['FROM `123.456`', '123.456'],
  ['Use EXTRACT(YEAR FROM d FROM private_dataset.customers', 'private_dataset.customers'],
  ['Use EXTRACT( then SELECT * FROM private_dataset.customers', 'private_dataset.customers'],
  ['We extract (from private_dataset.customers) the rows.', 'private_dataset.customers'],
  ['SELECT EXTRACT(YEAR, MONTH FROM private_dataset.customers)', 'private_dataset.customers'],
  ['acme-prod.analytics.orders', 'prod.analytics.orders'],
  ['Read warehouse-12345.45678.20261118 for the daily snapshot.', '12345.45678.20261118'],
  ['`acme-prod.analytics.orders`', 'acme-prod.analytics.orders'],
  ['```sql\nSELECT * FROM `private_dataset.customers`\n```', 'private_dataset.customers'],
  ['Unmatched ` on this line\nSELECT * FROM `private_dataset.customers`', 'private_dataset.customers'],
  ['`acme-bigquery-public-data.thelook_ecommerce.orders`', 'acme-bigquery-public-data.thelook_ecommerce.orders'],
  ['acme-bigquery-public-data.thelook_ecommerce.orders', 'acme-bigquery-public-data.thelook_ecommerce.orders'],
  ['`acme-tv_thelook.orders`', 'acme-tv_thelook.orders'],
  ['FROM acme-123.2024.01', 'acme-123.2024.01'],
  ['FROM acme-tv_thelook.orders', 'acme-tv_thelook.orders'],
  ['JOIN acme-123.2024.01', 'acme-123.2024.01'],
  ['Use tv_thelook.orders. acme.analytics.orders.', 'acme.analytics.orders'],
  ['Use bigquery-public-data.thelook_ecommerce.orders. acme.analytics.orders.', 'acme.analytics.orders'],
  ['SELECT o.gross-`private_dataset.customers` FROM tv_thelook.orders o', 'private_dataset.customers'],
  ['SELECT o.gross-`private_dataset`.`customers` FROM tv_thelook.orders o', 'private_dataset.customers'],
  ['SELECT o.gross-acme-prod.analytics.orders FROM tv_thelook.orders o', 'prod.analytics.orders'],
  ['Use `private_dataset`. Customers', 'private_dataset.Customers'],
  ['o.shipping_address.city', 'o.shipping_address.city'],
  ['tv_thelook.orders.id.extra', 'tv_thelook.orders.id.extra'],
  ['tv_thelook.not_a_table', 'tv_thelook.not_a_table'],
  ['Version v1.2.3', 'v1.2.3'],
  ['Filter by `status`. Return top 10.', 'status.Return'],
  ['Check orders. `revenue` is up.', 'orders.revenue'],
  ['SELECT * FROM # a comment\n (private_dataset\n . \t customers JOIN tv_thelook.users ON TRUE)', 'private_dataset.customers'],
  ['SELECT TRUE # FROM private_dataset.customers', 'private_dataset.customers'],
  [String.raw`FROM tv_thelook.orders -- note\n, private_dataset.customers`, 'private_dataset.customers'],
  [String.raw`SELECT * FROM tv_thelook.orders -- path C:\Notes WHERE old\n, private_dataset.customers`, 'private_dataset.customers'],
  [String.raw`Use \North.analytics.orders`, 'North.analytics.orders'],
  [String.raw`Use \Traffic.analytics.orders`, 'Traffic.analytics.orders'],
  [JSON.stringify({ sql: 'FROM tv_thelook.orders JOIN tv_thelook.users ON t.name = "Example", private_dataset.customers' }), 'private_dataset.customers'],
  ['123.analytics.orders', '123.analytics.orders'],
  ['An undeclared x.y.z in prose', 'x.y.z'],
  ['Pull data from the acme warehouse: acme.analytics.orders', 'acme.analytics.orders'],
  [JSON.stringify({ text: 'Pull data from the acme warehouse: acme.analytics.orders' }), 'acme.analytics.orders'],
  ['Join two acme tables: acme.analytics.orders', 'acme.analytics.orders'],
  ['FROM private_dataset . customers', 'private_dataset.customers'],
  ['FROM private_dataset .customers', 'private_dataset.customers'],
  // Capitalized after the comment, so only the comment keeps these from reading as sentence ends.
  ['FROM private_dataset. /* note */ Customers', 'private_dataset.Customers'],
  ['FROM private_dataset. -- note\n Customers', 'private_dataset.Customers'],
  ['FROM private_dataset. customers', 'private_dataset.customers'],
  ['FROM private_dataset.\n  customers', 'private_dataset.customers'],
  ['FROM `private_dataset`. customers', 'private_dataset.customers'],
  ['Use `private_dataset` . `customers`', 'private_dataset.customers'],
  // The IAM-permission exemption covers only an unquoted bigquery.<resource>.<verb> after "Permission".
  ['Permission acme.analytics.orders denied', 'acme.analytics.orders'],
  ['Permission `bigquery.tables.update` denied', 'bigquery.tables.update'],
  ['Permission bigquery.tables.update.extra denied', 'bigquery.tables.update.extra'],
  ['Use bigquery.tables.update for this', 'bigquery.tables.update'],
  ['Permission foo-bigquery.tables.update denied', 'bigquery.tables.update'],
  ['permission BigQuery.tables.update denied', 'BigQuery.tables.update'],
  // A new SELECT ends a prose FROM list, but its own FROM list is still scanned.
  ['Data came from different builds.\nSELECT a FROM tv_thelook.orders, private_dataset.customers', 'private_dataset.customers'],
  // WITH OFFSET inside a FROM list does not end it.
  ['FROM tv_thelook.orders, UNNEST(o.items) WITH OFFSET AS i, private_dataset.customers', 'private_dataset.customers'],
  ['Permission denied: SELECT * FROM bigquery.tables.update', 'bigquery.tables.update'],
  // A fence only ends a dot chain; a table path inside the fenced SQL is still scanned.
  ['Totals rose from 8,400 to 9,600.\n\n```sql\nSELECT 1 FROM private_dataset.customers\n```', 'private_dataset.customers'],
  // Inline code with parentheses is scanned as SQL, not skipped.
  ['Try `SELECT COUNT(*) FROM private_dataset.customers` instead', 'private_dataset.customers'],
  ['Use `acme.analytics.orders(x)` here', 'acme.analytics.orders'],
  // A dotted path right before a parenthesis stays a quoted identifier, in or out of a FROM list.
  ['Use `private_dataset.customers(x)` in prose', 'private_dataset.customers'],
  ['SELECT * FROM `private_dataset.some_tvf(1)`', 'private_dataset.some_tvf'],
  ['Call `tv_thelook.orders_fn(SELECT 1 FROM private_dataset.customers)`', 'private_dataset.customers'],
  // Without parentheses a single-backtick span is still one quoted identifier.
  ['Use `private_dataset.customers` here', 'private_dataset.customers'],
])('flags the foreign reference in %s', (input, reference) => {
  expect(scanTemplateSafety(input)).toContain(`Foreign table reference: ${reference}`);
});

it.each(['"""', "'''"].flatMap((quote) => {
  const sql = `SELECT * FROM tv_thelook.orders o\nJOIN tv_thelook.users u ON o.name = ${quote}First line\n#1${quote}, private_dataset.customers`;
  return [
    ['raw SQL', quote, sql],
    ['JSON-wrapped SQL', quote, JSON.stringify({ sql })],
    ['standalone escaped SQL', quote, JSON.stringify(sql).slice(1, -1)],
  ];
}))('flags a FROM-list table in %s after a multiline %s literal', (_format, _quote, input) => {
  expect(scanTemplateSafety(input)).toContain('Foreign table reference: private_dataset.customers');
});

it.each([
  'Use e.g. orders.',
  'U.S. customers',
  'Yes. No. Maybe',
  'Use acme. analytics. orders',
  'Use Alpha. Beta. Gamma',
  'Use a.b. orders',
  'version 1.2.3',
  '```sql\nSELECT * FROM tv_thelook.orders\n```',
  '```sql\nSELECT * FROM `tv_thelook.orders`\n```',
  'Use ``tv_thelook.orders`` for orders.',
  'Use `` `tv_thelook.orders` `` for orders.',
  'Use ``SELECT * FROM tv_thelook.orders`` for orders.',
  'Use ``SELECT*FROM(tv_thelook.orders)`` for orders.',
  'e.g. revenue',
  'tv_thelook.orders',
  'tv_thelook.orders.order_id',
  'bigquery-public-data.thelook_ecommerce.users',
  'BIGQUERY-public-data.thelook_ecommerce.users',
  'SELECT o.price-u.cost FROM tv_thelook.orders o JOIN tv_thelook.users u ON TRUE',
  'SELECT EXTRACT(YEAR FROM u.created_at) AS signup_year FROM tv_thelook.users u',
  'SELECT EXTRACT(DATE FROM o.created_at AT TIME ZONE "UTC") FROM tv_thelook.orders o',
  'SELECT EXTRACT(WEEK(MONDAY) FROM o.created_at) FROM tv_thelook.orders o',
  'select extract(isoweek from o.created_at) from tv_thelook.orders o',
  'The spread runs from 13.0% for Dresses down to 11.8% for Shorts.',
  'Revenue grew from 1.25 to 3.5 million.',
  'Take the site from product_distribution_center_id. SQL:\nSELECT 1 FROM tv_thelook.orders',
  'Start from private_dataset. Then join the rest.',
  // Deliberate gap: a capitalized word after "dataset. " reads as a new sentence.
  'FROM private_dataset. Customers',
  'Access Denied: Table tv_thelook.distribution_centers: Permission bigquery.tables.update denied on table tv_thelook.distribution_centers',
  'Missing permissions bigquery.jobs.create',
  // A prose number before a code fence is not joined to the fence's language tag.
  'Total selling price rose from 8,400 to 9,600.\n\n```sql\nSELECT SUM(sale_price) FROM `tv_thelook.order_items`\n```',
  // A fence between a name and a following dot also ends the chain.
  'Totals rose from 8,400 to 9,600\n```\n.sql files are attached',
  // Inline code naming functions is not a quoted table path.
  'I changed `COUNT(i.id)` to `COUNT(*)`. Which row is mine counting?',
  'Flag it if the two sides came from different builds.\n\nSELECT u.traffic_source AS signup_source, e.event_type FROM tv_thelook.users u JOIN tv_thelook.events e ON e.user_id = u.id',
])('allows %s', (text) => {
  expect(scanTemplateSafety(text)).toEqual([]);
});

it('allows subtraction between qualified columns', () => {
  expect(scanTemplateSafety('SELECT o.gross-o.net, o.delivered_at-o.created_at FROM tv_thelook.orders o')).toEqual([]);
});

it.each(['o', 'AS o'])('flags a three-part path through an alias declared with %s', (alias) => {
  expect(scanTemplateSafety(`FROM tv_thelook.orders ${alias} WHERE o.shipping_address.city = 'Paris'`))
    .toContain('Foreign table reference: o.shipping_address.city');
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

it.each(['"""', "'''"].flatMap(quote => {
  const sql = `SELECT * FROM tv_thelook.orders o
JOIN tv_thelook.users u ON u.note = ${quote}First line
Second line
, private_dataset.customers c
WHERE c.note = ${quote}Another
note${quote}`;
  return [['raw', quote, sql], ['serialized', quote, JSON.stringify({ sql })]];
}))('retains FROM-list detections in %s SQL with ambiguous %s', (_format, _quote, input) => {
  expect(scanTemplateSafety(input)).toContain('Foreign table reference: private_dataset.customers');
});
