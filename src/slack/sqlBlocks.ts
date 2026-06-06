import type { KnownBlock, ActionsBlock, SectionBlock } from '@slack/types';
import type { ResponseContext } from '../types.js';

// Block-id prefix for the on-demand SQL panel, mirroring REASONING_BLOCK_PREFIX.
// app.ts uses it to strip the panel back out when "Hide SQL" is clicked.
export const SQL_BLOCK_PREFIX = 'sql_';

// The SQL is hidden by default and revealed on demand via the "Show SQL" toggle.
// It is read straight from the persisted ResponseContext — no re-query — so the
// answer's clutter stays low while the exact query remains one click away for
// trust and verification.
export function buildSqlBlocks(ctx: ResponseContext): KnownBlock[] {
  return [
    {
      type: 'section',
      block_id: `${SQL_BLOCK_PREFIX}query`,
      text: { type: 'mrkdwn', text: `\`\`\`${ctx.generatedSql}\`\`\`` },
    } as SectionBlock,
    {
      type: 'actions',
      block_id: `${SQL_BLOCK_PREFIX}actions`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Hide SQL' },
          action_id: `hide_sql_${ctx.traceId}`,
          value: `${ctx.threadTs}_${ctx.statusMsgTs}`,
        },
      ],
    } as ActionsBlock,
  ];
}
