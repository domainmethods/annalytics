/**
 * Static help/onboarding content, shared by `/anna help` (ephemeral message)
 * and the App Home tab. Template-generic by design: no client table names,
 * domains, or metrics — implementations replace the examples with their own.
 * Only header/section/context/divider blocks: valid on both surfaces.
 */
export function buildHelpBlocks(): Record<string, unknown>[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '👋 I\'m Anna Lytics' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'I answer questions about our data in plain English — I translate your question ' +
          'into SQL, run it against the warehouse, and reply with the results.',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*How to ask*\n' +
          '• `/anna <your question>` in any channel I\'ve been added to\n' +
          '• @mention me in a channel\n' +
          '• DM me directly\n\n' +
          'For example: _"How many orders did we get last week?"_ · ' +
          '_"What were the top products by revenue last month?"_ · ' +
          '_"How does signup volume compare to the previous quarter?"_',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*What to expect*\n' +
          '• If your question is ambiguous, I\'ll ask a *clarifying question* first — ' +
          'answer it (or cancel) and I\'ll continue.\n' +
          '• If I\'m not confident in an answer, I\'ll *ask the data team* and follow up ' +
          'in your thread when they respond.\n' +
          '• Answers include buttons for *feedback* (👍/👎), *my reasoning*, and ' +
          '*the SQL I ran* — plus alternate formats (table, summary, CSV) when the ' +
          'result shape supports them.',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'There\'s an hourly per-person query limit, and large/expensive queries are blocked before they run.',
        },
      ],
    },
  ];
}
