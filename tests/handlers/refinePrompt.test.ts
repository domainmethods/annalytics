import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSaveRefinementTarget, mockGetRefinementTarget, mockConsumeRefinementTarget, mockWarn } = vi.hoisted(() => ({
  mockConsumeRefinementTarget: vi.fn(),
  mockSaveRefinementTarget: vi.fn(),
  mockGetRefinementTarget: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('../../src/state/refinementTarget.js', () => ({
  saveRefinementTarget: mockSaveRefinementTarget,
  getRefinementTarget: mockGetRefinementTarget,
  consumeRefinementTarget: mockConsumeRefinementTarget,
}));
vi.mock('../../src/logging.js', () => ({
  rootLogger: { warn: mockWarn, info: vi.fn(), error: vi.fn() },
}));

import { finishRefinementTarget, lookupRefinementTarget, promptRefinement, REFINE_PROMPT_TEXT } from '../../src/handlers/refinePrompt.js';

function makeClient() {
  return { chat: { postMessage: vi.fn().mockResolvedValue({ ts: 'p1' }) } } as any;
}

describe('promptRefinement (#51)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves the clicked answer as the target and posts the prompt in the thread', async () => {
    mockSaveRefinementTarget.mockResolvedValue(undefined);
    const client = makeClient();

    const prompted = await promptRefinement({ channel: 'C1', threadTs: 'T1', statusMsgTs: 'S1', userId: 'U1', client });

    expect(prompted).toBe(true);
    expect(mockSaveRefinementTarget).toHaveBeenCalledWith({ channel: 'C1', threadTs: 'T1', userId: 'U1', responseKey: 'T1_S1' });
    expect(client.chat.postMessage).toHaveBeenCalledWith({ channel: 'C1', thread_ts: 'T1', text: REFINE_PROMPT_TEXT });
  });

  it('does not post the prompt, and reports failure, when the target cannot be saved', async () => {
    mockSaveRefinementTarget.mockRejectedValue(new Error('firestore down'));
    const client = makeClient();

    const prompted = await promptRefinement({ channel: 'C1', threadTs: 'T1', statusMsgTs: 'S1', userId: 'U1', client });

    expect(prompted).toBe(false);
    expect(mockWarn).toHaveBeenCalledWith({ err: 'firestore down' }, 'refine.target_save_failed');
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('lookupRefinementTarget (#51)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the picked answer key', async () => {
    mockGetRefinementTarget.mockResolvedValue('T1_S1');
    await expect(lookupRefinementTarget('C1', 'T1', 'U1')).resolves.toEqual({ status: 'found', key: 'T1_S1' });
  });

  it('returns none when nothing is pending', async () => {
    mockGetRefinementTarget.mockResolvedValue(null);
    await expect(lookupRefinementTarget('C1', 'T1', 'U1')).resolves.toEqual({ status: 'none' });
  });

  it('reports a read failure as failed, not none', async () => {
    mockGetRefinementTarget.mockRejectedValue(new Error('firestore down'));
    await expect(lookupRefinementTarget('C1', 'T1', 'U1')).resolves.toEqual({ status: 'failed' });
    expect(mockWarn).toHaveBeenCalledWith({ err: 'firestore down' }, 'refine.target_lookup_failed');
  });
});

describe('finishRefinementTarget (#51)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('consumes the target it was handed', async () => {
    mockConsumeRefinementTarget.mockResolvedValue(undefined);
    await finishRefinementTarget('C1', 'T1', 'U1', 'T1_S1');
    expect(mockConsumeRefinementTarget).toHaveBeenCalledWith('C1', 'T1', 'U1', 'T1_S1');
  });

  it('logs, without throwing, when the delete fails', async () => {
    mockConsumeRefinementTarget.mockRejectedValue(new Error('firestore down'));
    await expect(finishRefinementTarget('C1', 'T1', 'U1', 'T1_S1')).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith({ err: 'firestore down' }, 'refine.target_consume_failed');
  });
});
