import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { TeachingCandidate } from '../../src/state/teachingCandidates.js';

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

vi.mock('../../src/state/teachingCandidates.js', () => ({
  getPendingCandidates: vi.fn(),
  updateCandidateStatus: vi.fn(),
}));

vi.mock('../../src/state/firestore.js', () => ({
  initFirestore: vi.fn(),
}));

import { updateCandidateStatus } from '../../src/state/teachingCandidates.js';
import { runPromotion } from '../../scripts/promote-teachings.js';

function createMockRl(answers: string[]) {
  let index = 0;
  return {
    question: vi.fn(async () => answers[index++] || 's'),
    close: vi.fn(),
  };
}

function makeCandidate(overrides: Partial<TeachingCandidate> = {}): TeachingCandidate {
  return {
    candidateId: 'teach_esc_abc123',
    escalationId: 'esc_abc123',
    status: 'pending',
    questionPatterns: ['How many active users do we have?', 'What is the active user count?'],
    reasoning: 'Count active users from the users dimension table',
    sanctionedSql: 'SELECT COUNT(*) FROM `project.dataset.dim_users` WHERE is_active = true',
    modelsReferenced: ['dim_users'],
    tags: ['users', 'metrics'],
    originalQuestion: 'how many active users?',
    humanResponse: 'Use dim_users and filter by is_active = true',
    generatedAt: new Date('2026-02-15T10:00:00Z'),
    ...overrides,
  };
}

describe('promote-teachings CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes YAML file for approved candidate', async () => {
    const candidate = makeCandidate();
    const rl = createMockRl(['a']);

    await runPromotion(rl, [candidate]);

    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [filePath, content] = vi.mocked(writeFileSync).mock.calls[0] as [string, string];
    expect(filePath).toContain('teachings/teach_esc_abc123.yml');

    // Verify YAML is valid and has correct structure
    const parsed = parseYaml(content) as { teachings: unknown[] };
    expect(parsed.teachings).toHaveLength(1);

    const teaching = parsed.teachings[0] as Record<string, unknown>;
    expect(teaching.id).toBe('teach_esc_abc123');
    expect(teaching.question_patterns).toEqual([
      'How many active users do we have?',
      'What is the active user count?',
    ]);
    expect(teaching.sanctioned_sql).toBe(
      'SELECT COUNT(*) FROM `project.dataset.dim_users` WHERE is_active = true',
    );
    expect(teaching.reasoning).toBe('Count active users from the users dimension table');
    expect(teaching.models_referenced).toEqual(['dim_users']);
    expect(teaching.tags).toEqual(['users', 'metrics']);
    expect(teaching.author).toBe('escalation-promotion');
    expect(teaching.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(updateCandidateStatus).toHaveBeenCalledWith('teach_esc_abc123', 'approved');
  });

  it('updates status to rejected', async () => {
    const candidate = makeCandidate();
    const rl = createMockRl(['r']);

    await runPromotion(rl, [candidate]);

    expect(updateCandidateStatus).toHaveBeenCalledWith('teach_esc_abc123', 'rejected');
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('skips candidate without status change', async () => {
    const candidate = makeCandidate();
    const rl = createMockRl(['s']);

    await runPromotion(rl, [candidate]);

    expect(updateCandidateStatus).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('returns correct summary counts', async () => {
    const candidates = [
      makeCandidate({ candidateId: 'teach_1', escalationId: 'esc_1' }),
      makeCandidate({ candidateId: 'teach_2', escalationId: 'esc_2' }),
      makeCandidate({ candidateId: 'teach_3', escalationId: 'esc_3' }),
    ];
    const rl = createMockRl(['a', 'r', 's']);

    const result = await runPromotion(rl, candidates);

    expect(result).toEqual({ approved: 1, rejected: 1, skipped: 1 });
  });

  it('handles candidate with null sanctioned SQL', async () => {
    const candidate = makeCandidate({ sanctionedSql: null });
    const rl = createMockRl(['a']);

    await runPromotion(rl, [candidate]);

    const [, content] = vi.mocked(writeFileSync).mock.calls[0] as [string, string];
    const parsed = parseYaml(content) as { teachings: { sanctioned_sql: unknown }[] };
    expect(parsed.teachings[0].sanctioned_sql).toBeNull();
  });

  it('ensures teachings directory exists before writing', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const candidate = makeCandidate();
    const rl = createMockRl(['a']);

    await runPromotion(rl, [candidate]);

    expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining('teachings'), { recursive: true });
  });
});
