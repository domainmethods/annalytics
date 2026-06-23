import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockDelete = vi.fn();
const mockDoc = vi.fn(() => ({
  set: mockSet,
  get: mockGet,
  delete: mockDelete,
}));
const mockCollection = vi.fn(() => ({ doc: mockDoc }));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({ collection: mockCollection })),
}));

import {
  deleteWhatsAppPendingFeedback,
  getWhatsAppPendingFeedback,
  saveWhatsAppPendingFeedback,
} from '../../src/state/whatsappPendingFeedback.js';

describe('whatsappPendingFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
    mockDelete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves pending feedback by conversation id with timestamps', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-06-23T00:00:00.000Z');
    vi.setSystemTime(now);

    await saveWhatsAppPendingFeedback({
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
      responseContextKey: 'response-key',
      traceId: 'trace-1',
      clarifiedQuestion: 'What was revenue?',
    });

    expect(mockCollection).toHaveBeenCalledWith('whatsapp_pending_feedback_notes');
    expect(mockDoc).toHaveBeenCalledWith('whatsapp:15551234567');
    expect(mockSet).toHaveBeenCalledWith({
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
      responseContextKey: 'response-key',
      traceId: 'trace-1',
      clarifiedQuestion: 'What was revenue?',
      createdAt: now,
      expiresAt: new Date('2026-06-23T00:30:00.000Z'),
    });
  });

  it('returns null when the pending feedback doc is missing', async () => {
    mockGet.mockResolvedValue({ exists: false });

    await expect(getWhatsAppPendingFeedback('whatsapp:15551234567')).resolves.toBeNull();
  });

  it('loads pending feedback and converts Firestore timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:10:00.000Z'));
    const createdAt = new Date('2026-06-23T00:00:00.000Z');
    const expiresAt = new Date('2026-06-23T00:30:00.000Z');
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
        responseContextKey: 'response-key',
        traceId: 'trace-1',
        clarifiedQuestion: 'What was revenue?',
        createdAt: { toDate: () => createdAt },
        expiresAt: { toDate: () => expiresAt },
      }),
    });

    await expect(getWhatsAppPendingFeedback('whatsapp:15551234567')).resolves.toEqual({
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
      responseContextKey: 'response-key',
      traceId: 'trace-1',
      clarifiedQuestion: 'What was revenue?',
      createdAt,
      expiresAt,
    });
  });

  it('deletes pending feedback by conversation id', async () => {
    await deleteWhatsAppPendingFeedback('whatsapp:15551234567');

    expect(mockCollection).toHaveBeenCalledWith('whatsapp_pending_feedback_notes');
    expect(mockDoc).toHaveBeenCalledWith('whatsapp:15551234567');
    expect(mockDelete).toHaveBeenCalledWith();
  });
});
