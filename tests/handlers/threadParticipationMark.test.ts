import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRecord, mockWarn } = vi.hoisted(() => ({ mockRecord: vi.fn(), mockWarn: vi.fn() }));
vi.mock('../../src/state/threadParticipation.js', () => ({ recordThreadParticipation: mockRecord }));
vi.mock('../../src/logging.js', () => ({ rootLogger: { warn: mockWarn, info: vi.fn(), error: vi.fn() } }));

import { markThreadParticipation } from '../../src/handlers/threadParticipationMark.js';

describe('markThreadParticipation (#53)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the thread', async () => {
    mockRecord.mockResolvedValue(undefined);
    await markThreadParticipation('C1', 'T1');
    expect(mockRecord).toHaveBeenCalledWith('C1', 'T1');
  });

  it('logs and swallows a failed write', async () => {
    mockRecord.mockRejectedValue(new Error('firestore down'));
    await expect(markThreadParticipation('C1', 'T1')).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith({ err: 'firestore down' }, 'thread_participation.record_failed');
  });
});
