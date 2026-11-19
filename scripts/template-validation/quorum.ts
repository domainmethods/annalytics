import type { LabelerConfig } from './labelers.js';
import { referenceIsOrdered, resultsEquivalent } from './resultEquivalence.js';

export type QuorumKind = 'full' | 'reduced' | 'single';
export type QueryResultLike = { columnNames: string[]; rows: Record<string, unknown>[] };

export function validateQuorum(
  members: LabelerConfig[],
  allowSingleFamily: boolean,
): { members: LabelerConfig[]; kind: QuorumKind } {
  const byFamily = new Map<LabelerConfig['family'], LabelerConfig>();
  for (const member of members) {
    if (!byFamily.has(member.family)) byFamily.set(member.family, member);
  }

  const count = byFamily.size;
  if (count === 0) throw new Error('No quorum members');
  if (count === 1 && !allowSingleFamily) {
    throw new Error('A one-family quorum requires --allow-single-family');
  }
  const kind = count >= 3 ? 'full' : count === 2 ? 'reduced' : 'single';
  return { members: [...byFamily.values()], kind };
}

export function agreeClosedSet<T extends string | boolean>(
  labels: (T | Error)[],
): { agreed: true; value: T } | { agreed: false } {
  const [value] = labels;
  if ((typeof value === 'string' || typeof value === 'boolean') && labels.every(label => label === value)) {
    return { agreed: true, value };
  }
  return { agreed: false };
}

export async function agreeSql(
  sqls: (string | Error)[],
  execute: (sql: string) => Promise<QueryResultLike | Error>,
): Promise<{ agreed: true; reference: string } | { agreed: false; reason: string }> {
  if (sqls.length === 0) return { agreed: false, reason: 'No SQL members' };

  let firstResult: QueryResultLike | undefined;
  let ordered = false;
  let reference = '';
  for (const [index, sql] of sqls.entries()) {
    if (sql instanceof Error) return { agreed: false, reason: `Member ${index} failed to supply SQL` };

    let result: QueryResultLike | Error;
    try {
      result = await execute(sql);
    } catch {
      return { agreed: false, reason: `Member ${index} SQL execution failed` };
    }
    if (result instanceof Error) {
      return { agreed: false, reason: `Member ${index} SQL execution failed` };
    }

    if (firstResult === undefined) {
      firstResult = result;
      ordered = referenceIsOrdered(sql);
      reference = sql;
    } else {
      if (!resultsEquivalent(firstResult, result, { ordered })) {
        return { agreed: false, reason: `Member ${index} SQL result differs from member 0` };
      }
      if (sql.trim().length < reference.trim().length) reference = sql;
    }
  }
  return { agreed: true, reference };
}

export function agreeRubric(proposed: string[], votes: boolean[][]): string[] {
  if (votes.length === 0) return [];
  return proposed.filter((_, index) => votes.every(memberVotes => memberVotes[index] === true));
}
