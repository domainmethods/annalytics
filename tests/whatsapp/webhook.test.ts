import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, Router } from 'express';
import type { ChannelClient } from '../../src/channels/types.js';
import type { TableContext } from '../../src/dbt/types.js';
import type { PipelineConfig } from '../../src/pipeline.js';

const mockValues = vi.hoisted(() => ({
  handleWhatsAppMessages: vi.fn(),
  handleUnsupportedWhatsAppMessages: vi.fn(),
  loggerError: vi.fn(),
  rawMiddleware: Symbol('express.raw.middleware'),
}));

vi.mock('../../src/whatsapp/messages.js', () => ({
  handleWhatsAppMessages: mockValues.handleWhatsAppMessages,
  handleUnsupportedWhatsAppMessages: mockValues.handleUnsupportedWhatsAppMessages,
}));

vi.mock('../../src/logging.js', () => ({
  rootLogger: {
    error: mockValues.loggerError,
  },
}));

vi.mock('express', () => ({
  default: {
    raw: vi.fn(() => mockValues.rawMiddleware),
  },
}));

import express from 'express';
import { registerWhatsAppWebhook } from '../../src/whatsapp/webhook.js';

const VERIFY_TOKEN = 'verify-token';
const APP_SECRET = 'app-secret';
const PHONE_NUMBER_ID = 'phone-1';

type Handler = (req: Request, res: Response) => void | Promise<void>;

let getHandler: Handler;
let postMiddleware: unknown;
let postHandler: Handler;
let router: Router;

const client: ChannelClient = {
  sendText: vi.fn(async () => ({ messageId: 'outbound-1' })),
};

const deps = {
  verifyToken: VERIFY_TOKEN,
  appSecret: APP_SECRET,
  phoneNumberId: PHONE_NUMBER_ID,
  client,
  tables: [] as TableContext[],
  config: {} as PipelineConfig,
  rateLimitPerHour: 30,
  allowedWaIds: ['15551234567'],
};

function sign(body: Buffer): string {
  return `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function whatsappPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: PHONE_NUMBER_ID },
          messages: [{
            from: '15551234567',
            id: 'wamid.1',
            timestamp: '1780000000',
            type: 'text',
            text: { body: 'Show revenue yesterday' },
          }],
        },
      }],
    }],
    ...overrides,
  };
}

function req(overrides: Partial<Request> & { rawBody?: unknown } = {}): Request {
  return {
    query: {},
    headers: {},
    body: undefined,
    ...overrides,
  } as Request;
}

function res(): {
  response: Response;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const response = {
    headersSent: false,
    status: vi.fn(function status(this: Response) {
      return this;
    }),
    send: vi.fn(function send(this: Response) {
      return this;
    }),
    json: vi.fn(function json(this: Response) {
      return this;
    }),
  } as unknown as Response;

  return {
    response,
    status: vi.mocked(response.status),
    send: vi.mocked(response.send),
    json: vi.mocked(response.json),
  };
}

describe('registerWhatsAppWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    router = {
      get: vi.fn((_path: string, handler: Handler) => {
        getHandler = handler;
      }),
      post: vi.fn((_path: string, middleware: unknown, handler: Handler) => {
        postMiddleware = middleware;
        postHandler = handler;
      }),
    } as unknown as Router;
    mockValues.handleWhatsAppMessages.mockResolvedValue(undefined);
    mockValues.handleUnsupportedWhatsAppMessages.mockResolvedValue(undefined);
    (client.sendText as ReturnType<typeof vi.fn>).mockResolvedValue({ messageId: 'outbound-1' });

    registerWhatsAppWebhook(router, deps);
  });

  it('registers GET and POST routes with raw JSON middleware before the async handler', () => {
    expect(router.get).toHaveBeenCalledWith('/whatsapp/webhook', expect.any(Function));
    expect(express.raw).toHaveBeenCalledWith({ type: 'application/json' });
    expect(router.post).toHaveBeenCalledWith(
      '/whatsapp/webhook',
      mockValues.rawMiddleware,
      expect.any(Function),
    );
    expect(postMiddleware).toBe(mockValues.rawMiddleware);
    expect(postHandler.constructor.name).toBe('AsyncFunction');
  });

  it('returns the challenge for valid GET verification', () => {
    const { response, status, send } = res();

    getHandler(req({
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': 'challenge-123',
      },
    }), response);

    expect(status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith('challenge-123');
  });

  it('returns 403 for invalid GET verification', () => {
    const { response, status, send } = res();

    getHandler(req({
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'challenge-123',
      },
    }), response);

    expect(status).toHaveBeenCalledWith(403);
    expect(send).toHaveBeenCalledWith('Forbidden');
  });

  it('returns 401 for a bad POST signature and does not call the handler', async () => {
    const rawBody = Buffer.from(JSON.stringify(whatsappPayload()));
    const { response, status, send } = res();

    await postHandler(req({
      body: rawBody,
      headers: { 'x-hub-signature-256': sign(Buffer.from('different-body')) },
    }), response);

    expect(status).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledWith('Unauthorized');
    expect(mockValues.handleWhatsAppMessages).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON with a valid signature and does not call the handler', async () => {
    const rawBody = Buffer.from('{not json');
    const { response, status, send } = res();

    await postHandler(req({
      body: rawBody,
      headers: { 'x-hub-signature-256': sign(rawBody) },
    }), response);

    expect(status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith('Bad Request');
    expect(mockValues.handleWhatsAppMessages).not.toHaveBeenCalled();
  });

  it('uses preserved rawBody for signatures when req.body is already parsed', async () => {
    const payload = whatsappPayload();
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { response, status, send } = res();

    await postHandler(req({
      rawBody,
      body: payload,
      headers: { 'x-hub-signature-256': [sign(rawBody), 'sha256=ignored'] },
    }), response);

    expect(mockValues.handleWhatsAppMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        surface: 'whatsapp',
        providerMessageId: 'wamid.1',
        text: 'Show revenue yesterday',
        conversation: {
          surface: 'whatsapp',
          conversationId: 'whatsapp:15551234567',
          userId: '15551234567',
        },
      }),
    ], {
      client,
      tables: deps.tables,
      config: deps.config,
      rateLimitPerHour: 30,
      allowedWaIds: ['15551234567'],
    });
    expect(status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith('OK');
  });

  it('routes unsupported messages through the guarded handler', async () => {
    const payload = whatsappPayload({
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: PHONE_NUMBER_ID },
            messages: [{
              from: '15551234567',
              id: 'wamid.image',
              timestamp: '1780000000',
              type: 'image',
              image: { id: 'media-1' },
            }],
          },
        }],
      }],
    });
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { response, status, send } = res();

    await postHandler(req({
      body: rawBody,
      headers: { 'x-hub-signature-256': sign(rawBody) },
    }), response);

    expect(mockValues.handleUnsupportedWhatsAppMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        providerMessageId: 'wamid.image',
        conversation: {
          surface: 'whatsapp',
          conversationId: 'whatsapp:15551234567',
          userId: '15551234567',
        },
        type: 'image',
      }),
    ], {
      client,
      tables: deps.tables,
      config: deps.config,
      rateLimitPerHour: 30,
      allowedWaIds: ['15551234567'],
    });
    expect(mockValues.handleWhatsAppMessages).toHaveBeenCalledWith([], {
      client,
      tables: deps.tables,
      config: deps.config,
      rateLimitPerHour: 30,
      allowedWaIds: ['15551234567'],
    });
    expect(client.sendText).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith('OK');
  });

  it('returns 500 when message handling fails', async () => {
    mockValues.handleWhatsAppMessages.mockRejectedValue(new Error('internal provider detail'));
    const rawBody = Buffer.from(JSON.stringify(whatsappPayload()));
    const { response, status, send } = res();

    await postHandler(req({
      body: rawBody,
      headers: { 'x-hub-signature-256': sign(rawBody) },
    }), response);

    expect(mockValues.loggerError).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'whatsapp.webhook_error',
    );
    expect(status).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledWith('Internal Server Error');
  });
});
