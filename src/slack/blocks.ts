import type { KnownBlock, ActionsBlock, SectionBlock } from '@slack/types';

export function buildSingleValueBlocks(
  value: string,
  explanation: string,
  sql: string,
  traceId: string,
  threadTs?: string,
  statusMsgTs?: string,
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
    buildFeedbackActions(traceId, threadTs, statusMsgTs),
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

export function buildFeedbackActions(traceId: string, threadTs?: string, statusMsgTs?: string): ActionsBlock {
  const elements: ActionsBlock['elements'] = [
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
  ];

  if (threadTs && statusMsgTs) {
    const compoundKey = `${threadTs}_${statusMsgTs}`;
    elements.push(
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Reasoning' },
        action_id: `show_reasoning_${traceId}`,
        value: compoundKey,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Table' },
        action_id: `override_table_${traceId}`,
        value: compoundKey,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Summary' },
        action_id: `override_summary_${traceId}`,
        value: compoundKey,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'CSV' },
        action_id: `override_csv_${traceId}`,
        value: compoundKey,
      },
    );
  }

  return { type: 'actions', elements };
}
