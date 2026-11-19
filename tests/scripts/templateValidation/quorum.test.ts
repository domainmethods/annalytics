import { describe, expect, it } from 'vitest';
import type { LabelerConfig } from '../../../scripts/template-validation/labelers.js';
import {
  agreeClosedSet, agreeRubric, agreeSql, validateQuorum,
} from '../../../scripts/template-validation/quorum.js';

function labeler(id: string, family: LabelerConfig['family'], outputParser: LabelerConfig['outputParser']): LabelerConfig {
  return { id, family, outputParser, argv: [id], model: 'test-model', effortArgs: [], versionArgv: ['--version'] };
}

const agy = labeler('agy', 'google', 'agy-json');
const gemini = labeler('gemini', 'google', 'gemini-json');
const claude = labeler('claude', 'anthropic', 'claude-json');
const codex = labeler('codex', 'openai', 'codex-jsonl');

describe('validateQuorum', () => {
  it('counts agy+gemini as one family', () => {
    expect(validateQuorum([agy, gemini, claude], false)).toEqual({ members: [agy, claude], kind: 'reduced' });
    expect(validateQuorum([gemini, agy, claude, codex], false)).toEqual({
      members: [gemini, claude, codex], kind: 'full',
    });
  });

  it('refuses single family without flag', () => {
    expect(() => validateQuorum([agy, gemini], false)).toThrow('--allow-single-family');
    expect(validateQuorum([agy, gemini], true)).toEqual({ members: [agy], kind: 'single' });
  });

  it('refuses an empty quorum even with the flag', () => {
    expect(() => validateQuorum([], true)).toThrow();
  });
});

describe('agreeClosedSet', () => {
  it('requires unanimity', () => {
    expect(agreeClosedSet(['keep', 'keep'])).toEqual({ agreed: true, value: 'keep' });
    expect(agreeClosedSet([false, false])).toEqual({ agreed: true, value: false });
    expect(agreeClosedSet([true, true, false])).toEqual({ agreed: false });
    expect(agreeClosedSet([])).toEqual({ agreed: false });
  });

  it('returns no agreement on any member error', () => {
    const error = new Error('labeler failed');
    expect(agreeClosedSet([true, error, true])).toEqual({ agreed: false });
    expect(agreeClosedSet([error])).toEqual({ agreed: false });
  });
});

describe('agreeSql', () => {
  const execute = async () => ({ columnNames: ['n'], rows: [{ n: 1 }] });

  it('picks shortest equivalent reference by trimmed length, retaining the earliest tie', async () => {
    expect(await agreeSql(['SELECT 1 AS n', '  SELECT 1  ', 'select 1'], execute)).toEqual({
      agreed: true, reference: 'SELECT 1',
    });
  });

  it('disagrees when one query fails validation', async () => {
    expect(await agreeSql(['SELECT 1', 'SELECT 2'], async sql =>
      sql === 'SELECT 2' ? new Error('validation failed') : execute(),
    )).toEqual({ agreed: false, reason: expect.stringMatching(/member 1\b/i) });
  });

  it('names members that supplied an error or whose executor threw a non-Error', async () => {
    expect(await agreeSql(['SELECT 1', new Error('labeler failed')], execute)).toEqual({
      agreed: false, reason: expect.stringMatching(/member 1\b/i),
    });
    expect(await agreeSql(['SELECT 1'], async () => { throw 'execution failed'; })).toEqual({
      agreed: false, reason: expect.stringMatching(/member 0\b/i),
    });
    expect(await agreeSql([], execute)).toMatchObject({ agreed: false });
  });

  it('uses the first SQL to decide row ordering even when another SQL is shorter', async () => {
    const ordered = 'SELECT n FROM t ORDER BY n LIMIT 2';
    const unordered = 'SELECT n FROM t';
    const executeRows = async (sql: string) => ({
      columnNames: ['n'], rows: sql === ordered ? [{ n: 1 }, { n: 2 }] : [{ n: 2 }, { n: 1 }],
    });

    expect(await agreeSql([ordered, unordered], executeRows)).toMatchObject({ agreed: false });
    expect(await agreeSql([unordered, ordered], executeRows)).toEqual({ agreed: true, reference: unordered });
  });

  it('compares each result with the first when numeric tolerance is non-transitive', async () => {
    expect(await agreeSql(['1', '1.0000009', '0.9999991'], async sql => ({
      columnNames: ['n'], rows: [{ n: Number(sql) }],
    }))).toEqual({ agreed: true, reference: '1' });
  });
});

describe('agreeRubric', () => {
  it('keeps only facts all members kept', () => {
    expect(agreeRubric(['a', 'b', 'c', 'd'], [[true, true, true, true], [false, true, false, true], [true, true]]))
      .toEqual(['b']);
    expect(agreeRubric(['a'], [])).toEqual([]);
  });
});
