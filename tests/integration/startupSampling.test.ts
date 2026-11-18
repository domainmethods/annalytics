import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { query, getDoc, setDoc, start } = vi.hoisted(() => ({
  query: vi.fn(),
  getDoc: vi.fn(),
  setDoc: vi.fn(),
  start: vi.fn(),
}));

vi.mock('@google-cloud/bigquery', () => ({ BigQuery: class { query = query; } }));
vi.mock('@google-cloud/firestore', () => ({
  Firestore: class {
    doc(path: string) {
      return { get: () => getDoc(path), set: (data: unknown) => setDoc(path, data) };
    }

    collection(name: string) {
      return { doc: (id: string) => this.doc(`${name}/${id}`) };
    }
  },
  FieldValue: {},
}));
vi.mock('@slack/bolt', () => ({
  App: class {
    start = start;
    command() {}
    event() {}
    action() {}
    view() {}
  },
  ExpressReceiver: class { router = { get: vi.fn(), post: vi.fn() }; },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubEnv('SLACK_BOT_TOKEN', 'test');
  vi.stubEnv('SLACK_SIGNING_SECRET', 'test');
  vi.stubEnv('GEMINI_API_KEY', 'test');
  vi.stubEnv('GCP_PROJECT_ID', 'test');
  vi.stubEnv('DBT_MANIFEST_PATH', 'tests/fixtures/manifest.json');
  vi.stubEnv('DBT_CATALOG_PATH', 'tests/fixtures/catalog.json');
  vi.stubEnv('WHATSAPP_ENABLED', 'false');
  vi.stubEnv('COST_GATE_MAX_BYTES', '52428800');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function sampleDoc(ageDays: number) {
  const fetchedAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  return {
    exists: true,
    data: () => ({ rows: [{ id: 1 }], fetchedAt: { toDate: () => fetchedAt } }),
  };
}

it('starts the bot while refreshing only missing and stale samples within the byte budget', async () => {
  getDoc.mockImplementation(async (path: string) => {
    if (path === 'sample_rows/analytics.fct_orders') return sampleDoc(6);
    if (path === 'sample_rows/staging.stg_orders') return sampleDoc(8);
    return { exists: false };
  });

  let finishFirstQuery!: () => void;
  const firstQuery = new Promise<void>(resolve => { finishFirstQuery = resolve; });
  query.mockImplementation(async ({ query, maximumBytesBilled }) => {
    if (query.includes('dim_customers')) await firstQuery;
    if (Number(maximumBytesBilled) < 1_073_741_824) throw new Error('Query exceeded limit for bytes billed');
    return [[{ id: 2 }]];
  });

  const { rootLogger } = await import('../../src/logging.js');
  const info = vi.spyOn(rootLogger, 'info');
  let queriesWhilePending: number;
  try {
    await import('../../src/app.js');
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalled();
    });
    queriesWhilePending = query.mock.calls.length;
  } finally {
    finishFirstQuery();
  }

  await vi.waitFor(() => expect(info).toHaveBeenCalledWith(expect.anything(), 'Sample rows cached'));
  expect(queriesWhilePending).toBe(1);
  expect(query.mock.calls).toEqual([
    [{ query: 'SELECT * FROM `analytics.dim_customers` LIMIT 5', useLegacySql: false, maximumBytesBilled: '52428800' }],
    [{ query: 'SELECT * FROM `staging.stg_orders` LIMIT 5', useLegacySql: false, maximumBytesBilled: '52428800' }],
  ]);
  expect(setDoc).not.toHaveBeenCalled();
}, 15_000);

it('keeps sampling other models after individual cache reads or writes fail', async () => {
  getDoc.mockImplementation(async (path: string) => {
    if (path === 'sample_rows/analytics.fct_orders') throw new Error('Cache read failed');
    return { exists: false };
  });
  setDoc.mockImplementation(async (path: string) => {
    if (path === 'sample_rows/analytics.dim_customers') throw new Error('Cache write failed');
  });
  query.mockResolvedValue([[{ id: 2 }]]);

  await import('../../src/app.js');

  await vi.waitFor(() => expect(setDoc).toHaveBeenCalledWith('sample_rows/staging.stg_orders', {
    rows: [{ id: 2 }],
    fetchedAt: expect.any(Date),
  }));
  expect(query.mock.calls.map(([options]) => options.query)).toEqual([
    'SELECT * FROM `analytics.dim_customers` LIMIT 5',
    'SELECT * FROM `staging.stg_orders` LIMIT 5',
  ]);
}, 15_000);
