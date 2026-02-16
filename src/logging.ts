import pino from 'pino';
import { randomUUID } from 'node:crypto';
import type { PipelineLog } from './types.js';

const rootLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ severity: label.toUpperCase() }),
  },
  // Cloud Logging expects 'message' not 'msg'
  messageKey: 'message',
});

export function createTraceId(): string {
  return randomUUID();
}

export function createLogger(traceId: string) {
  return rootLogger.child({ traceId });
}

export function logStage(logger: pino.Logger, log: PipelineLog): void {
  logger.info(log, `pipeline.${log.stage}`);
}

export { rootLogger };
