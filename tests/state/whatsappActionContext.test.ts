import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockDoc = vi.fn(() => ({ set: mockSet, get: mockGet }));
const mockCollection = vi.fn(() => ({ doc: mockDoc }));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({ collection: mockCollection })),
}));

import {
  createWhatsAppActionContext,
  getWhatsAppActionContext,
} from '../../src/state/whatsappActionContext.js';

describe('whatsappActionContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
  });

  it('stores action context with a generated id and ttl', async () => {
    const id = await createWhatsAppActionContext({
      idFactory: () => 'ctx_123',
      kind: 'show_sql',
      responseContextKey: 'whatsapp:15551234567_wamid.1',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
    });

    expect(id).toBe('ctx_123');
    expect(mockCollection).toHaveBeenCalledWith('whatsapp_action_context');
    expect(mockDoc).toHaveBeenCalledWith('ctx_123');
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'show_sql',
      responseContextKey: 'whatsapp:15551234567_wamid.1',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
      createdAt: expect.any(Date),
      expiresAt: expect.any(Date),
    }));
  });

  it('returns null when the action context doc is missing', async () => {
    mockGet.mockResolvedValue({ exists: false });

    await expect(getWhatsAppActionContext('ctx_missing')).resolves.toBeNull();
  });

  it('loads stored action context and converts Firestore timestamps', async () => {
    const createdAt = new Date('2026-06-23T01:00:00.000Z');
    const expiresAt = new Date('2026-06-24T01:00:00.000Z');
    mockGet.mockResolvedValue({
      exists: true,
      id: 'ctx_123',
      data: () => ({
        kind: 'show_reasoning',
        responseContextKey: 'key-1',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
        createdAt: { toDate: () => createdAt },
        expiresAt: { toDate: () => expiresAt },
      }),
    });

    await expect(getWhatsAppActionContext('ctx_123')).resolves.toEqual({
      id: 'ctx_123',
      kind: 'show_reasoning',
      responseContextKey: 'key-1',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
      createdAt,
      expiresAt,
    });
  });
});

