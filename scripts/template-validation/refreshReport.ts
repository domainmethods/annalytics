import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveModelId } from '../../src/agents/modelConfig.js';
import { defaultProfileForNode, type NodeId } from '../../src/agents/nodeProfiles.js';
import type { NodeOutcome } from '../node-sweep.js';
import type { Provenance } from './labelQuorum.js';

export interface RefreshRow {
  node: NodeId;
  current: string;
  recommended: string;
  currentMetric: number;
  recommendedMetric: number;
  eps: number;
  signal: 'strong' | 'medium' | 'weak';
  costDelta: number;
  p95Ms: number;
  applicable: boolean;
  flatAtFloor: boolean;
  quorumMemberWinner: boolean;
}

interface RefreshMeta {
  setVersion: string;
  setHash: string;
  date: string;
  provenance: Provenance;
}

const signal: Record<NodeId, RefreshRow['signal']> = {
  slackIntake: 'strong', followUpClassifier: 'strong', ambiguityClassifier: 'strong',
  clarification: 'strong', teachingCandidate: 'strong', sqlGenerator: 'strong', supervisor: 'strong',
  dbtStatus: 'medium', chart: 'medium', summaryOverride: 'medium',
  metaQuestion: 'weak', discrepancy: 'weak',
};

export function buildRefreshRows(
  outcomes: NodeOutcome[], epsByNode: Map<NodeId, number>, provenance: Provenance,
): RefreshRow[] {
  const quorumModels = new Set(provenance.members.flatMap(member => [member.requestedModel, ...member.reportedModels]));
  return outcomes.map(({ nodeId: node, baseline, chosen, chosenRung, stage1, stage2 }) => {
    const eps = epsByNode.get(node);
    if (eps === undefined) throw new Error(`Missing calibrated epsilon for ${node}`);

    const defaultProfile = defaultProfileForNode(node);
    const recommendedProfile = chosenRung ?? defaultProfile;
    const recommendedModel = resolveModelId(recommendedProfile.tier, recommendedProfile.version);
    const current = `${resolveModelId(defaultProfile.tier, defaultProfile.version)}@${defaultProfile.thinkingLevel}`;
    const recommended = `${recommendedModel}@${recommendedProfile.thinkingLevel}`;
    const metrics = [...stage1, ...stage2].map(point => point.metric);
    const max = Math.max(...metrics);
    const flatAtFloor = max - Math.min(...metrics) <= eps && max < 0.9;
    return {
      node, current, recommended, currentMetric: baseline.metric, recommendedMetric: chosen.metric,
      eps, signal: signal[node], costDelta: chosen.cost - baseline.cost, p95Ms: chosen.p95LatencyMs,
      applicable: eps <= 0.05 && !flatAtFloor && recommended !== current,
      flatAtFloor, quorumMemberWinner: quorumModels.has(recommendedModel),
    };
  });
}

export function renderRefreshReport(rows: RefreshRow[], meta: RefreshMeta): string {
  const lines: string[] = [];
  if (meta.provenance.singleFamily || meta.provenance.reducedQuorum) {
    const quorum = meta.provenance.singleFamily ? 'Single-family quorum' : 'Reduced quorum';
    lines.push(`> **Warning** · ${quorum} labeled this validation set.`, '');
  }
  lines.push(
    `# Model refresh · ${meta.date}`, '',
    `Validation set ${meta.setVersion} · ${meta.setHash}`, '',
    '| Node | Current | Recommended | Current metric | Recommended metric | ε | Signal | Cost Δ (USD) | p95 (ms) | Applicable | Flat at floor | Quorum member | Set version | Set hash |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const row of rows) {
    lines.push(`| ${[
      row.node, row.current, row.recommended, row.currentMetric.toFixed(3), row.recommendedMetric.toFixed(3),
      row.eps.toFixed(4), row.signal, row.costDelta.toExponential(2), row.p95Ms, row.applicable,
      row.flatAtFloor, row.quorumMemberWinner, meta.setVersion, meta.setHash,
    ].join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}

export async function writeRefreshReport(dir: string, rows: RefreshRow[], meta: RefreshMeta): Promise<void> {
  await mkdir(dir, { recursive: true });
  const base = join(dir, `${meta.date}-model-refresh`);
  await writeFile(base + '.md', renderRefreshReport(rows, meta), 'utf8');
  await writeFile(base + '.json', JSON.stringify({ ...meta, rows }, null, 2) + '\n', 'utf8');
}
