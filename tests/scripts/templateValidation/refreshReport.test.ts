import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { NodeOutcome } from '../../../scripts/node-sweep.js';
import { buildRefreshRows, renderRefreshReport, writeRefreshReport } from '../../../scripts/template-validation/refreshReport.js';
import type { Provenance } from '../../../scripts/template-validation/labelQuorum.js';
import { resolveModelId } from '../../../src/agents/modelConfig.js';

const chosenRung = { tier: 'flash-lite', version: '3.1', thinkingLevel: 'minimal' } as const;
const provenance: Provenance = {
  version: 'test', createdAt: '2026-11-18', quorumKind: 'reduced', reducedQuorum: true, singleFamily: false,
  drafter: 'test', perNode: {}, members: [
    { id: 'test', family: 'gemini', cliVersion: '1', requestedModel: 'other', reportedModels: [resolveModelId(chosenRung.tier, chosenRung.version)] },
  ],
};
const baseline = { label: 'DEFAULT', metric: 0.3, e2e: 0.3, p95LatencyMs: 200, cost: 0.02 };
const chosen = { ...baseline, label: 'flash-lite/3.1@minimal', metric: 0.31, cost: 0.01 };
const outcome: NodeOutcome = {
  nodeId: 'supervisor', baseline, chosen, chosenRung, stage1Winner: chosenRung,
  stage1: [baseline], stage2: [chosen], e2eCritical: true,
};
const meta = { setVersion: 'test', setHash: 'test-set-hash', date: '2026-11-18', provenance };

it('marks flat-at-floor rows inapplicable and flags reported or requested quorum models', () => {
  const eps = new Map([['supervisor', 0.02]] as const);
  expect(buildRefreshRows([outcome], eps, provenance)[0]).toMatchObject({
    flatAtFloor: true, applicable: false, quorumMemberWinner: true, costDelta: -0.01, eps: 0.02, signal: 'strong',
  });
  const otherProvenance = { ...provenance, members: provenance.members.map(member => ({
    ...member, requestedModel: member.reportedModels[0], reportedModels: [],
  })) };
  expect(buildRefreshRows([{ ...outcome, stage1: [{ ...baseline, metric: 0.9 }] }], eps, otherProvenance)[0])
    .toMatchObject({ flatAtFloor: false, applicable: true, quorumMemberWinner: true });
});

it('starts with the reduced-quorum warning and prints epsilon and set hash in every row', () => {
  const rows = buildRefreshRows([outcome, { ...outcome, nodeId: 'metaQuestion' }], new Map([
    ['supervisor', 0.02], ['metaQuestion', 0.06],
  ]), provenance);
  const report = renderRefreshReport(rows, meta);
  expect(report.split('\n')[0]).toMatch(/warning.*reduced.quorum/i);
  for (const row of rows) {
    const line = report.split('\n').find(line => line.startsWith(`| ${row.node} |`));
    expect(line).toContain(row.eps.toFixed(4));
    expect(line).toContain(meta.setHash);
  }
});

it('writes Markdown and JSON to the requested output directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'refresh-report-'));
  try {
    const rows = buildRefreshRows([outcome], new Map([['supervisor', 0.02]]), provenance);
    await writeRefreshReport(dir, rows, meta);
    const base = join(dir, '2026-11-18-model-refresh');
    expect(await readFile(base + '.md', 'utf8')).toBe(renderRefreshReport(rows, meta));
    expect(JSON.parse(await readFile(base + '.json', 'utf8'))).toEqual({ ...meta, rows });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
