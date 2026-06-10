import type { WebClient } from '@slack/web-api';
import type { EscalationState } from '../types.js';

export async function notifyEscalationTimeout(
  state: EscalationState,
  client: WebClient,
): Promise<void> {
  const text = state.behavior === 'park_wait'
    ? "I wasn't able to get an answer from the data team in time. Try asking again or reach out directly."
    : "The data team hasn't weighed in yet, but the answer I showed earlier is my best estimate.";

  await client.chat.postMessage({
    channel: state.originalChannel,
    thread_ts: state.originalThreadTs,
    text,
  });
}
