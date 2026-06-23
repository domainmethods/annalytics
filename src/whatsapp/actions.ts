import type { WhatsAppClient } from './client.js';
import type { WhatsAppInteractiveAction } from './payload.js';
import type { TableContext } from '../dbt/types.js';
import type { PipelineConfig } from '../pipeline.js';

export interface HandleWhatsAppActionsDeps {
  client: WhatsAppClient;
  tables: TableContext[];
  config: PipelineConfig;
  rateLimitPerHour: number;
  allowedWaIds: string[];
}

export async function handleWhatsAppActions(
  _actions: WhatsAppInteractiveAction[],
  _deps: HandleWhatsAppActionsDeps,
): Promise<void> {
}
