import type { KnownBlock, ActionsBlock, SectionBlock } from '@slack/types';
import type { ResponseContext } from '../types.js';

export const REASONING_BLOCK_PREFIX = 'reasoning_';

export function buildReasoningBlocks(ctx: ResponseContext): KnownBlock[] {
  const teachings = ctx.teachingsUsed || [];
  const teachingsList = teachings.length > 0
    ? teachings.map(t => `\`${t}\``).join(', ')
    : 'None';

  const tables = ctx.tablesUsed || [];
  const verdict = ctx.supervisorVerdict || 'N/A';
  const notes = ctx.supervisorNotes || '';

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      block_id: `${REASONING_BLOCK_PREFIX}tables`,
      text: {
        type: 'mrkdwn',
        text: `*Tables used:* ${tables.map(t => `\`${t}\``).join(', ') || 'None'}`,
      },
    } as SectionBlock,
    {
      type: 'section',
      block_id: `${REASONING_BLOCK_PREFIX}teachings`,
      text: {
        type: 'mrkdwn',
        text: `*Teachings referenced:* ${teachingsList}`,
      },
    } as SectionBlock,
    {
      type: 'section',
      block_id: `${REASONING_BLOCK_PREFIX}supervisor`,
      text: {
        type: 'mrkdwn',
        text: `*Supervisor:* ${verdict}${notes ? ` — ${notes}` : ''}`,
      },
    } as SectionBlock,
    {
      type: 'section',
      block_id: `${REASONING_BLOCK_PREFIX}confidence`,
      text: {
        type: 'mrkdwn',
        text: `*Confidence:* ${ctx.confidence || 'N/A'}`,
      },
    } as SectionBlock,
    {
      type: 'actions',
      block_id: `${REASONING_BLOCK_PREFIX}actions`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Hide reasoning' },
          action_id: `hide_reasoning_${ctx.traceId}`,
          value: `${ctx.threadTs}_${ctx.statusMsgTs}`,
        },
      ],
    } as ActionsBlock,
  ];

  return blocks;
}
