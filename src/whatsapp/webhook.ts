import express, { type Request, type Response, type Router } from 'express';
import type { ChannelClient } from '../channels/types.js';
import type { TableContext } from '../dbt/types.js';
import {
  handleUnsupportedWhatsAppMessages,
  handleWhatsAppMessages,
} from '../handlers/whatsappMessages.js';
import { rootLogger } from '../logging.js';
import type { PipelineConfig } from '../pipeline.js';
import { parseWhatsAppWebhookPayload } from './payload.js';
import { verifyWhatsAppSignature } from './signature.js';

interface RegisterWhatsAppWebhookDeps {
  verifyToken: string;
  appSecret: string;
  phoneNumberId: string;
  client: ChannelClient;
  tables: TableContext[];
  config: PipelineConfig;
  rateLimitPerHour: number;
  allowedWaIds: string[];
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return firstQueryValue(value[0]);
  return typeof value === 'string' ? value : undefined;
}

function rawBodyFrom(req: Request): Buffer {
  const rawBody = (req as Request & { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  return Buffer.from('');
}

function payloadFrom(req: Request, rawBody: Buffer): unknown {
  if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  return JSON.parse(rawBody.toString('utf8'));
}

export function registerWhatsAppWebhook(
  router: Router,
  deps: RegisterWhatsAppWebhookDeps,
): void {
  router.get('/whatsapp/webhook', (req: Request, res: Response) => {
    const mode = firstQueryValue(req.query['hub.mode']);
    const token = firstQueryValue(req.query['hub.verify_token']);
    const challenge = firstQueryValue(req.query['hub.challenge']);

    if (mode === 'subscribe' && token === deps.verifyToken && challenge) {
      res.status(200).send(challenge);
      return;
    }

    res.status(403).send('Forbidden');
  });

  router.post(
    '/whatsapp/webhook',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      try {
        const rawBody = rawBodyFrom(req);
        const signatureHeader = firstHeader(req.headers['x-hub-signature-256']);
        const verified = verifyWhatsAppSignature({
          appSecret: deps.appSecret,
          rawBody,
          signatureHeader,
        });
        if (!verified) {
          res.status(401).send('Unauthorized');
          return;
        }

        let payload: unknown;
        try {
          payload = payloadFrom(req, rawBody);
        } catch {
          res.status(400).send('Bad Request');
          return;
        }

        const parsed = parseWhatsAppWebhookPayload(payload, deps.phoneNumberId);
        await handleUnsupportedWhatsAppMessages(parsed.unsupported, {
          client: deps.client,
          tables: deps.tables,
          config: deps.config,
          rateLimitPerHour: deps.rateLimitPerHour,
          allowedWaIds: deps.allowedWaIds,
        });
        await handleWhatsAppMessages(parsed.messages, {
          client: deps.client,
          tables: deps.tables,
          config: deps.config,
          rateLimitPerHour: deps.rateLimitPerHour,
          allowedWaIds: deps.allowedWaIds,
        });

        res.status(200).send('OK');
      } catch (error) {
        rootLogger.error({ err: error }, 'whatsapp.webhook_error');
        if (!res.headersSent) {
          res.status(500).send('Internal Server Error');
        }
      }
    },
  );
}
