import type { KnownBlock, SectionBlock, HeaderBlock } from '@slack/types';

export interface EscalationBlocksParams {
  userQuestion: string;
  channelName: string;
  threadLink: string;
  stuckDescription: string;
  bestGuessSql?: string;
}

export interface EscalationReminderParams {
  escalationId: string;
  originalQuestion: string;
  elapsed: string;
}

export function buildEscalationBlocks(params: EscalationBlocksParams): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '\ud83d\udd14 Anna Lytics needs help' },
    } as HeaderBlock,
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*User question:* "${params.userQuestion}"`,
      },
    } as SectionBlock,
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Channel:* ${params.channelName} (<${params.threadLink}|view thread>)`,
      },
    } as SectionBlock,
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*What I'm stuck on:* ${params.stuckDescription}`,
      },
    } as SectionBlock,
  ];

  if (params.bestGuessSql) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*My best guess:*\n\`\`\`${params.bestGuessSql}\`\`\``,
      },
    } as SectionBlock);
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: params.bestGuessSql
        ? 'React with \u2705 if my guess is correct, or reply with guidance.'
        : 'Reply in this thread with guidance.',
    },
  } as SectionBlock);

  return blocks;
}

export function buildUserWaitingBlocks(): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "I've asked the data team \u2014 I'll reply here when I have the answer.",
      },
    } as SectionBlock,
  ];
}

export function buildBestEffortCaveatBlocks(supervisorNotes: string): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u26a0\ufe0f *Note:* I'm not fully confident in this answer. The data team is verifying it.\n_${supervisorNotes}_`,
      },
    } as SectionBlock,
  ];
}

export function buildEscalationResolvedBlocks(
  humanResponse: string,
  behavior: 'best_effort_verify' | 'park_wait',
): KnownBlock[] {
  const prefix = behavior === 'best_effort_verify'
    ? 'The data team reviewed my answer:'
    : 'The data team responded:';

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\ud83d\udce9 *${prefix}*\n${humanResponse}`,
      },
    } as SectionBlock,
  ];
}

export function buildEscalationReminderBlocks(params: EscalationReminderParams): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\u23f0 *Reminder \u2014 still waiting on this one* (${params.elapsed})\n"${params.originalQuestion}"`,
      },
    } as SectionBlock,
  ];
}
