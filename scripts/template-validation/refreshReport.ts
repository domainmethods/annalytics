import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getRegisteredModel, resolveModelId } from '../../src/agents/modelConfig.js';
import { defaultProfileForNode, type NodeId } from '../../src/agents/nodeProfiles.js';
import type { NodeOutcome } from '../node-sweep.js';
import { formatSweepProfile, type SweepFailure } from '../node-sweep-types.js';
import { templateTargetCount } from './items.js';
import type { Provenance } from './labelQuorum.js';

export type ProfileFailureCount = SweepFailure & { profile: string; count: number };

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
  acceptedCount: number;
  dropRate: number | null;
  applicable: boolean;
  applicationReason?: string;
  failureCounts: ProfileFailureCount[];
  flatAtFloor: boolean;
  quorumMemberWinner: boolean;
}

interface RefreshMeta {
  setVersion: string;
  setHash: string;
  date: string;
  provenance: Provenance;
  partialNodes?: NodeId[];
}

const signal: Record<NodeId, RefreshRow['signal']> = {
  slackIntake: 'strong', followUpClassifier: 'strong', ambiguityClassifier: 'strong',
  clarification: 'strong', teachingCandidate: 'strong', sqlGenerator: 'strong', supervisor: 'strong',
  dbtStatus: 'medium', chart: 'medium', summaryOverride: 'medium',
  metaQuestion: 'weak', discrepancy: 'weak',
};

export function buildRefreshRows(
  outcomes: NodeOutcome[], epsByNode: Map<NodeId, number>, provenance: Provenance,
  failuresByNode = new Map<NodeId, ProfileFailureCount[]>(), blocked = new Set<NodeId>(),
): RefreshRow[] {
  const quorumModels = new Set(provenance.members.flatMap(member => [member.requestedModel, ...member.reportedModels]));
  return outcomes.map(({ nodeId: node, baseline, chosen, chosenRung, stage1, stage2 }) => {
    const eps = epsByNode.get(node);
    if (eps === undefined) throw new Error(`Missing calibrated epsilon for ${node}`);

    const defaultProfile = defaultProfileForNode(node);
    const recommendedProfile = chosenRung ?? defaultProfile;
    const currentModel = resolveModelId(defaultProfile.tier, defaultProfile.version);
    const recommendedModel = resolveModelId(recommendedProfile.tier, recommendedProfile.version);
    const current = formatSweepProfile(defaultProfile);
    const recommended = formatSweepProfile(recommendedProfile);
    const metrics = [...stage1, ...stage2].map(point => point.metric);
    const max = Math.max(...metrics);
    const flatAtFloor = max - Math.min(...metrics) <= eps && max < 0.9;
    const { accepted: acceptedCount, drafted, quarantined } = provenance.perNode[node];
    const dropRate = drafted === 0 ? null : quarantined / drafted;
    const failureCounts = failuresByNode.get(node) ?? [];
    const infrastructureFailure = blocked.has(node) || failureCounts.some(failure => failure.category !== 'candidate');
    let applicationReason: string | undefined;
    if (acceptedCount * 2 < templateTargetCount(node)) {
      applicationReason = 'underfilled corpus';
    } else if (infrastructureFailure) {
      applicationReason = 'Infrastructure failures affected the comparison.';
    } else if (currentModel === recommendedModel && defaultProfile.thinkingLevel === recommendedProfile.thinkingLevel) {
      applicationReason = 'same resolved model';
    } else if (currentModel !== getRegisteredModel(defaultProfile.tier, defaultProfile.version)?.id ||
        recommendedModel !== getRegisteredModel(recommendedProfile.tier, recommendedProfile.version)?.id) {
      applicationReason = 'measured under local model override';
    }
    return {
      node, current, recommended, currentMetric: baseline.metric, recommendedMetric: chosen.metric,
      eps, signal: signal[node], costDelta: chosen.cost - baseline.cost, p95Ms: chosen.p95LatencyMs, acceptedCount, dropRate,
      applicable: applicationReason === undefined && eps <= 0.05 && !flatAtFloor,
      ...(applicationReason && { applicationReason }),
      failureCounts,
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
    '| Node | Current | Recommended | Current metric | Recommended metric | ε | Signal | Cost Δ (USD) | p95 (ms) | Accepted | Drop rate | Applicable | Reason | Flat at floor | Quorum member | Set version | Set hash |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const row of rows) {
    lines.push(`| ${[
      row.node, row.current, row.recommended, row.currentMetric.toFixed(3), row.recommendedMetric.toFixed(3),
      row.eps.toFixed(4), row.signal, row.costDelta.toExponential(2), row.p95Ms, row.acceptedCount,
      row.dropRate === null ? 'n/a' : `${(row.dropRate * 100).toFixed(1)}%`, row.applicable, row.applicationReason ?? '',
      row.flatAtFloor, row.quorumMemberWinner, meta.setVersion, meta.setHash,
    ].join(' | ')} |`);
  }
  const failureLines = rows.flatMap(row => row.failureCounts.map(({ profile, category, code, count }) =>
    `| ${row.node} | ${profile} | ${category} / ${code} | ${count} |`));
  if (failureLines.length) lines.push(
    '', '## Item failures by profile', '',
    '| Node | Profile | Category / code | Count |', '| --- | --- | --- | --- |', ...failureLines,
  );
  return lines.join('\n') + '\n';
}

export async function writeRefreshReport(dir: string, rows: RefreshRow[], meta: RefreshMeta): Promise<string> {
  await mkdir(dir, { recursive: true });
  const suffix = meta.partialNodes ? `-partial-${meta.partialNodes.join('-')}` : '';
  const base = join(dir, `${meta.date}-model-refresh${suffix}`);
  await writeFile(base + '.md', renderRefreshReport(rows, meta), 'utf8');
  await writeFile(base + '.json', JSON.stringify({ ...meta, rows }, null, 2) + '\n', 'utf8');
  return base;
}
