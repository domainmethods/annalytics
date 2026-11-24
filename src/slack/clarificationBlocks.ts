import { escapeMrkdwn } from './limits.js';
import type { KnownBlock } from '@slack/types';

export interface ClarificationBlocksOptions {
  clarificationId: string;
  clarifyingQuestions: string[];
  originalQuestion: string;
}

/** The introduction and the numbered questions: what stays once they are answered. */
function questionBlocks(clarifyingQuestions: string[]): KnownBlock[] {
  const blocks: KnownBlock[] = [
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

  return blocks;
}

export function buildClarificationBlocks(
  options: ClarificationBlocksOptions,
): KnownBlock[] {
  const blocks = questionBlocks(options.clarifyingQuestions);

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

/**
 * The clarifying message after the user has answered it: the questions stay so
 * the thread still reads in order, the reply hint and the Cancel button go.
 */
export function buildAnsweredClarificationBlocks(clarifyingQuestions: string[]): KnownBlock[] {
  return questionBlocks(clarifyingQuestions);
}

export interface PendingClarificationBlocksOptions {
  clarificationId: string;
  originalQuestion: string;
}

/** Guard 2's nudge — also the message fallback text in preflightChecks. */
export const PENDING_CLARIFICATION_TEXT =
  "I'm still waiting on your answer to my earlier question — reply to that message and I'll pick it up from there.";

/**
 * What a clarification answer is told when another run has the thread. The
 * answer was not taken and nothing running will use it, so it asks for it again.
 */
export const CLARIFICATION_ANSWER_NOT_TAKEN_TEXT =
  "I'm still finishing something in this thread, so I haven't picked up your answer yet. Please send it again in a moment.";

/** Preflight guard 2 block message: the nudge, the question being waited on, and a way out. */
export function buildPendingClarificationBlocks(
  options: PendingClarificationBlocksOptions,
): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: PENDING_CLARIFICATION_TEXT,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Waiting on my question about: _${escapeMrkdwn(options.originalQuestion)}_`,
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
): KnownBlock[] {
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
