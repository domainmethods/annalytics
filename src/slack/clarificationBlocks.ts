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

  return blocks;
}
