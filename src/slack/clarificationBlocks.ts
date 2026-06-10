export interface ClarificationBlocksOptions {
  clarificationId: string;
  clarifyingQuestions: string[];
  originalQuestion: string;
}

export function buildClarificationBlocks(
  options: ClarificationBlocksOptions,
): Record<string, unknown>[] {
  const { clarifyingQuestions } = options;

  const blocks: Record<string, unknown>[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "I want to make sure I get this right. A couple of quick questions:",
      },
    },
  ];

  for (let i = 0; i < clarifyingQuestions.length; i++) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${i + 1}. ${clarifyingQuestions[i]}*`,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: 'Reply with your choices, or just describe what you need in your own words.',
      },
    ],
  });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Never mind — cancel',
        },
        action_id: 'clarification_cancel',
        value: options.clarificationId,
      },
    ],
  });

  return blocks;
}

export interface PendingClarificationBlocksOptions {
  clarificationId: string;
  originalQuestion: string;
}

/** Preflight guard 2 block message: the nudge, the question being waited on, and a way out. */
export function buildPendingClarificationBlocks(
  options: PendingClarificationBlocksOptions,
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "I'm still waiting on your answer to my earlier question — reply to that message and I'll pick it up from there.",
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Waiting on my question about: _${options.originalQuestion}_`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Cancel that question',
          },
          action_id: 'clarification_cancel',
          value: options.clarificationId,
        },
      ],
    },
  ];

  return blocks;
}

/** Copy for a failed cancel — also the message fallback text in the handler. */
export const CANCEL_FAILED_TEXT =
  "Hmm, I couldn't cancel that just now — try again in a moment.";

/** Shown when the cancel delete fails: the failure copy plus a retry button. */
export function buildCancelFailedBlocks(
  clarificationId: string,
): Record<string, unknown>[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: CANCEL_FAILED_TEXT },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Try again' },
          action_id: 'clarification_cancel',
          value: clarificationId,
        },
      ],
    },
  ];
}
