import type { SectionBlock } from '@slack/types';

// https://docs.slack.dev/reference/block-kit/blocks/section-block/
export const SECTION_TEXT_LIMIT = 3000;
// https://docs.slack.dev/reference/block-kit/blocks/table-block/ (includes header cells)
export const TABLE_COLUMN_LIMIT = 20;
export const TABLE_ROW_LIMIT = 100;
export const TABLE_TEXT_LIMIT = 10000;

/** Rows shown in a Slack table/summary answer; the rest are in the CSV export. */
export const MAX_DISPLAY_ROWS = 20;

// Slack rejects messages over 50 blocks. Cap SQL so the answer, SQL, and
// controls always fit together (10 sections ≈ 29,000 characters of SQL).
export const MAX_SQL_SECTIONS = 10;

export function boundedPreview(text: string): string {
  const note = '\n… Preview truncated; full results are in the CSV export.';
  return text.length <= SECTION_TEXT_LIMIT ? text : text.slice(0, SECTION_TEXT_LIMIT - note.length - 4) + '\n```' + note;
}

/**
 * Bound free text to one section, cutting at a word boundary when possible.
 * Callers bound already-escaped text (escaping can grow it), so a cut never
 * leaves half an entity: a trailing partial `&amp;` / `&lt;` / `&gt;` is dropped.
 */
export function boundedText(text: string, limit = SECTION_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const marker = '…';
  const head = text.slice(0, limit - marker.length);
  const space = head.lastIndexOf(' ');
  return (space > limit / 2 ? head.slice(0, space) : head).replace(/&(?:a(?:m(?:p)?)?|l(?:t)?|g(?:t)?)?$/, '') + marker;
}

// Show SQL verbatim across up to MAX_SQL_SECTIONS sections; each section
// budgets its own fences and optional label. Longer SQL ends with an explicit
// note so a partial query is never mistaken for the whole one.
export function sqlSections(sql: string, prefix = '', blockId?: string): SectionBlock[] {
  const blocks: SectionBlock[] = [];
  const blockIdFor = (index: number) => blockId && (index === 0 ? blockId : `${blockId}_${index}`);
  const total = sql.length;
  do {
    const label = blocks.length === 0 ? prefix : '';
    const size = SECTION_TEXT_LIMIT - label.length - 6; // 6 = opening + closing ``` fences
    // Prefer cutting after a newline so a copied chunk never splits a token.
    const newline = sql.length > size ? sql.lastIndexOf('\n', size - 1) : -1;
    const chunk = sql.slice(0, newline > 0 ? newline + 1 : size);
    const id = blockIdFor(blocks.length);
    blocks.push({
      type: 'section',
      ...(id ? { block_id: id } : {}),
      text: { type: 'mrkdwn', text: `${label}\`\`\`${chunk}\`\`\`` },
    });
    sql = sql.slice(chunk.length);
  } while (sql.length && blocks.length < MAX_SQL_SECTIONS);
  if (sql.length) {
    const shown = total - sql.length;
    const id = blockIdFor(blocks.length);
    blocks.push({
      type: 'section',
      ...(id ? { block_id: id } : {}),
      text: {
        type: 'mrkdwn',
        text: `_SQL truncated for Slack: showing the first ${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} characters._`,
      },
    });
  }
  return blocks;
}

/**
 * Slack mrkdwn entity escapes, for text Slack would otherwise parse as control
 * syntax: a "<!here>" or "<url|label>" from a model or a stored question would
 * ping or link instead of rendering as written.
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
