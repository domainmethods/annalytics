import type { KnownBlock, SectionBlock, ActionsBlock } from '@slack/types';

export const FEEDBACK_REASON_PREFIX = 'fb_reason_';

export type FeedbackRoute = 'escalate' | 'refine' | 'record';

export interface FeedbackReason {
  id: string;
  label: string;
  route: FeedbackRoute;
}

// Order here is the button order in the prompt.
export const FEEDBACK_REASONS: FeedbackReason[] = [
  { id: 'wrong_number', label: 'Wrong number', route: 'escalate' },
  { id: 'wrong_data', label: 'Wrong data / tables', route: 'escalate' },
  { id: 'not_asked', label: 'Not what I asked', route: 'refine' },
  { id: 'other', label: 'Other', route: 'record' },
];

export function feedbackReasonById(id: string): FeedbackReason | undefined {
  return FEEDBACK_REASONS.find(r => r.id === id);
}

/**
 * Ephemeral prompt shown after a negative-feedback click. Each button carries the
 * compound key (`${threadTs}_${statusMsgTs}`) as its value so the reason handler
 * can load the persisted ResponseContext; the reason id is encoded in the action_id.
 */
export function buildFeedbackReasonBlocks(compoundKey: string): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Thanks for the flag — what was off? This routes it to the right fix.',
      },
    } as SectionBlock,
    {
      type: 'actions',
      block_id: `${FEEDBACK_REASON_PREFIX}actions`,
      elements: FEEDBACK_REASONS.map(reason => ({
        type: 'button',
        action_id: `${FEEDBACK_REASON_PREFIX}${reason.id}`,
        text: { type: 'plain_text', text: reason.label },
        value: compoundKey,
      })),
    } as ActionsBlock,
  ];
}

export function buildFeedbackAckBlocks(message: string): KnownBlock[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: message },
    } as SectionBlock,
  ];
}
