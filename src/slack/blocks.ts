import type { KnownBlock, ActionsBlock, SectionBlock } from '@slack/types';

export function buildSingleValueBlocks(
  value: string,
  explanation: string,
  sql: string,
  traceId: string,
): KnownBlock[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${value}*\n${explanation}` },
    } as SectionBlock,
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`${sql}\`\`\`` },
    } as SectionBlock,
    buildFeedbackActions(traceId),
  ];
}

export function buildTableBlocks(
  rows: Record<string, unknown>[],
  columnNames: string[],
): KnownBlock[] {
  // Block Kit has no native table — use a code block with padded columns
  const widths = columnNames.map((col) =>
    Math.max(col.length, ...rows.map((r) => String(r[col] ?? '').length)),
  );
  const header = columnNames.map((c, i) => c.padEnd(widths[i])).join(' | ');
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-');
  const dataRows = rows.map((row) =>
    columnNames.map((col, i) => String(row[col] ?? '').padEnd(widths[i])).join(' | '),
  );
  const tableText = [header, separator, ...dataRows].join('\n');

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`\n${tableText}\n\`\`\`` },
    } as SectionBlock,
  ];
}

export function buildZeroRowBlocks(
  assumptions: string[],
  sql: string,
): KnownBlock[] {
  const filterList = assumptions.length > 0
    ? `\n*Filters applied:* ${assumptions.join(', ')}`
    : '';

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Your query ran successfully but returned no results.${filterList}\n\nWant me to try with broader filters?`,
      },
    } as SectionBlock,
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`${sql}\`\`\`` },
    } as SectionBlock,
  ];
}

export function buildTruncatedBlocks(
  shownRows: number,
  totalRows: number,
): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Showing ${shownRows.toLocaleString()} of ${totalRows.toLocaleString()} rows.`,
      },
    } as SectionBlock,
  ];
}

export function buildFeedbackActions(traceId: string): ActionsBlock {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '👍' },
        action_id: `thumbs_up_${traceId}`,
        value: traceId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '👎' },
        action_id: `thumbs_down_${traceId}`,
        value: traceId,
      },
    ],
  };
}
