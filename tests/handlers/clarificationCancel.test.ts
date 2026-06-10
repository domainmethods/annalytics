import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';

vi.mock('../../src/state/clarificationState.js', () => ({
  deleteClarificationState: vi.fn(),
}));
vi.mock('../../src/logging.js', () => ({
  rootLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { deleteClarificationState } from '../../src/state/clarificationState.js';
import { handleClarificationCancel } from '../../src/handlers/clarificationCancel.js';

const mockUpdate = vi.fn();
const mockClient = { chat: { update: mockUpdate } } as unknown as WebClient;

const params = {
  clarificationId: 'clar_1',
  channel: 'C1',
  messageTs: '123.456',
  client: mockClient,
};

describe('handleClarificationCancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({ ok: true });
    vi.mocked(deleteClarificationState).mockResolvedValue(undefined);
  });

  it('deletes the state and updates the message to the cancelled copy', async () => {
    await handleClarificationCancel(params);

    expect(deleteClarificationState).toHaveBeenCalledWith('clar_1');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        ts: '123.456',
        text: expect.stringContaining('cancelled'),
        blocks: [],
      }),
    );
  });

  it('degrades with a retry message when the delete fails', async () => {
    vi.mocked(deleteClarificationState).mockRejectedValue(new Error('firestore down'));

    await expect(handleClarificationCancel(params)).resolves.toBeUndefined();

    const text = mockUpdate.mock.calls[0][0].text as string;
    expect(text).toContain('try again');
  });

  it('does not throw when the message update fails', async () => {
    mockUpdate.mockRejectedValue(new Error('message_not_found'));
    await expect(handleClarificationCancel(params)).resolves.toBeUndefined();
  });
});
