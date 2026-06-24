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

    const stored = mockSet.mock.calls[0][0];
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'show_sql',
      responseContextKey: 'whatsapp:15551234567_wamid.1',
      conversationId: 'whatsapp:15551234567',
      userId: '15551234567',
      createdAt: expect.any(Date),
    }));
    expect(stored).toMatchObject({
      createdAt: expect.any(Date),
      expiresAt: expect.any(Date),
    });
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime())
      .toBe(24 * 60 * 60 * 1000);
  });

  it('returns null when the action context doc is missing', async () => {
    mockGet.mockResolvedValue({ exists: false });

    await expect(getWhatsAppActionContext('ctx_missing')).resolves.toBeNull();
  });

  it('returns null when action context is expired', async () => {
    const now = Date.now();
    mockGet.mockResolvedValue({
      exists: true,
      id: 'ctx_123',
      data: () => ({
        kind: 'show_sql',
        responseContextKey: 'whatsapp:15551234567_wamid.1',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
        createdAt: new Date(now - 2 * 60 * 60 * 1000),
        expiresAt: new Date(now - 60 * 60 * 1000),
      }),
    });

    await expect(getWhatsAppActionContext('ctx_123')).resolves.toBeNull();
  });

  it('returns null for malformed action-context documents without throwing', async () => {
    const baseNow = Date.now();
    mockGet.mockResolvedValue({
      exists: true,
      id: 'ctx_123',
      data: () => ({
        kind: 42,
        responseContextKey: 'whatsapp:15551234567_wamid.1',
        conversationId: 'whatsapp:15551234567',
        userId: '15551234567',
        createdAt: { toDate: () => new Date(baseNow - 1000) },
        expiresAt: { toDate: () => new Date(baseNow + 1000) },
      }),
    });

    await expect(getWhatsAppActionContext('ctx_123')).resolves.toBeNull();
  });

  it('loads stored action context and converts Firestore timestamps', async () => {
    const createdAt = new Date(Date.now() - 60 * 60 * 1000);
    const expiresAt = new Date(createdAt.getTime() + 2 * 60 * 60 * 1000);
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
