import { boundedPreview, boundedText, SECTION_TEXT_LIMIT, TABLE_COLUMN_LIMIT, TABLE_ROW_LIMIT, TABLE_TEXT_LIMIT } from './limits.js';
import { unwrapBigQueryScalar } from '../execution/bigqueryScalar.js';
import type { EligibleComposition } from '../execution/composition.js';
import type { KnownBlock, ActionsBlock, SectionBlock, TableBlock, RawTextElement } from '@slack/types';

/** Display for an empty single-value answer. */
export const EMPTY_VALUE = '—';

/** Safely format a BigQuery cell value. A real JS Date renders as ISO; an SDK
 *  scalar wrapper (BigQueryDate etc.) renders its text; any other object — a
 *  STRUCT, even one with a `value` field — renders as JSON so no field is lost. */
export function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object') {
    const wrapped = unwrapBigQueryScalar(val);
    return wrapped !== undefined ? String(wrapped) : JSON.stringify(val);
  }
  return String(val);
}

// Leading blocks for an answer derived from assumptions: a context line listing
// the assumptions plus a "refine" actions block. Single source of truth shared
// by the initial render (pipeline) and the Table/Summary override re-renders so
// the refine affordance survives an override click. Returns [] when there are no
// assumptions. The context block carries text in `elements` (not a top-level
// `text`) — clients/tests rely on that exact shape.
// Assumptions arrive as full sentences ("'Traffic' refers to session count."),
// so a comma join reads as "count., 'Where'". Strip each item's trailing
// separator and join with "; " so the list reads as one clause sequence.
export function formatAssumptions(assumptions: string[]): string {
  return assumptions
    .map((a) => a.trim().replace(/[.;,]+$/, '').trim())
    .filter((a) => a.length > 0)
    .join('; ');
}

export function buildAssumptionBlocks(assumptions: string[], traceId: string): KnownBlock[] {
  const formatted = formatAssumptions(assumptions ?? []);
  if (formatted.length === 0) return [];
  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🔍 *Assumptions:* ${formatted}` }],
    } as KnownBlock,
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Change assumptions' },
        action_id: 'refine_assumptions',
        value: traceId,
      }],
    } as KnownBlock,
  ];
}

const HEADLINE_LIMIT = 500;

export function buildSingleValueBlocks(value: string, headline: string): KnownBlock[] {
  // Section only — the caller (buildResponseBlocks) appends assumptions and the
  // feedback actions row, uniform with every other content builder. The value is
  // the authoritative BigQuery cell (bold); the headline is the one-line label.
  return [
    {
      type: 'section',
      // Bound each part separately so truncation never drops the closing bold marker.
      text: { type: 'mrkdwn', text: `*${boundedText(value, SECTION_TEXT_LIMIT - HEADLINE_LIMIT - 3)}*\n${boundedText(headline, HEADLINE_LIMIT)}` },
    } as SectionBlock,
  ];
}

// block_ids tag which result view a message is showing, so re-renders (CSV,
// reasoning/SQL toggles) can hide the button for the view already on screen
// without persisting the view anywhere.
export const RESULT_TABLE_BLOCK_ID = 'anna_view_table';
export const RESULT_SUMMARY_BLOCK_ID = 'anna_view_summary';

export type ResultView = 'table' | 'summary';

export function currentViewFromBlocks(blocks: ReadonlyArray<{ type?: string; block_id?: string }> | undefined): ResultView | undefined {
  if (!blocks) return undefined;
  if (blocks.some((b) => b.block_id === RESULT_SUMMARY_BLOCK_ID)) return 'summary';
  // A native table block also counts, for messages rendered before tagging.
  if (blocks.some((b) => b.block_id === RESULT_TABLE_BLOCK_ID || b.type === 'table')) return 'table';
  return undefined;
}

const NATIVE_TABLE_MAX_COLS = TABLE_COLUMN_LIMIT; // Slack native table block hard cap.

export function buildTableBlocks(
  rows: Record<string, unknown>[],
  columnNames: string[],
  composition?: EligibleComposition,
): KnownBlock[] {
  // Fail safe: shares that don't line up with the rows would misattribute a
  // percentage, so render the plain Phase 1 table instead.
  const usable =
    composition !== undefined &&
    composition.shares.length === rows.length &&
    columnNames.includes(composition.dimension) &&
    columnNames.includes(composition.measure)
      ? composition
      : undefined;
  const header = usable ? [...columnNames, 'Share'] : columnNames;
  const body = rows.map((row, i) => {
    const cells = columnNames.map((col) => {
      const text = formatValue(row[col]);
      return usable && col === usable.dimension && text.length === 0 ? EMPTY_VALUE : text;
    });
    return usable ? [...cells, usable.shares[i].label] : cells;
  });
  if (usable) {
    body.push([
      ...columnNames.map((col) => (col === usable.dimension ? 'Total' : col === usable.measure ? usable.total : '')),
      '100%',
    ]);
  }
  const textRows = [header, ...body];
  // Slack's native table caps at 20 columns; wide results degrade to the legacy
  // monospace renderer rather than dropping columns.
  if (header.length > NATIVE_TABLE_MAX_COLS) return buildCodeBlockTable(textRows);
  const tableRows = textRows.map((r) =>
    r.map((text): RawTextElement => ({
      type: 'raw_text',
      // raw_text requires length >= 1; empty cells render as an em dash.
      text: text.length > 0 ? text : '—',
    })),
  );
  // Oversized tables fall back to the bounded text preview (which points to CSV)
  // rather than silently dropping rows or cells from the native table.
  const tableChars = tableRows.flat().reduce((sum, c) => sum + c.text.length, 0);
  if (tableRows.length > TABLE_ROW_LIMIT || tableChars > TABLE_TEXT_LIMIT) return buildCodeBlockTable(textRows);
  return [{ type: 'table', block_id: RESULT_TABLE_BLOCK_ID, rows: tableRows } satisfies TableBlock];
}

// Legacy monospace renderer: the fallback for >20 columns and for tables over
// Slack's native row or character limits. Takes header + body as text cells.
function buildCodeBlockTable(textRows: string[][]): KnownBlock[] {
  const [header, ...body] = textRows;
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join(' | ');
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-');
  const tableText = [line(header), separator, ...body.map(line)].join('\n');
  return [{ type: 'section', block_id: RESULT_TABLE_BLOCK_ID, text: { type: 'mrkdwn', text: boundedPreview(`\`\`\`\n${tableText}\n\`\`\``) } } as SectionBlock];
}

export function buildZeroRowBlocks(
  assumptions: string[],
): KnownBlock[] {
  const formatted = formatAssumptions(assumptions);
  const filterList = formatted.length > 0 ? `\n*Filters applied:* ${formatted}` : '';

  // No SQL block here either — the query is available via "Show SQL" if the
  // user wants to inspect why nothing came back.
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Your query ran successfully but returned no results.${filterList}\n\nWant me to try with broader filters?`,
      },
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

// Which output-override buttons to render. Each defaults to shown; pass `false`
// to suppress one. A zero-row result, for example, has nothing to tabulate or
// export, so its caller hides Table and CSV — buttons that would only re-run the
// same query and surface an empty table / header-only CSV.
export interface OverrideButtons {
  table?: boolean;
  summary?: boolean;
  csv?: boolean;
}

export function buildFeedbackActions(
  traceId: string,
  threadTs?: string,
  statusMsgTs?: string,
  overrides: OverrideButtons = {},
  sqlShown = false,
): ActionsBlock {
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
    // Reasoning and the SQL toggle are detail toggles, not output overrides —
    // they surface the same answer's "why" and "what ran" regardless of result
    // shape — so both are always present when the toggle keys exist. The SQL
    // toggle flips in place: it reads "Show SQL" while hidden and "Hide SQL"
    // once the panel is open, so the feedback row stays visible alongside the
    // revealed SQL (additive, not a swap). The SQL itself is loaded from
    // persisted ResponseContext — no re-query — for trust/verification.
    elements.push(
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Reasoning' },
        action_id: `show_reasoning_${traceId}`,
        value: compoundKey,
      },
      sqlShown
        ? {
            type: 'button',
            text: { type: 'plain_text', text: 'Hide SQL' },
            action_id: `hide_sql_${traceId}`,
            value: compoundKey,
          }
        : {
            type: 'button',
            text: { type: 'plain_text', text: 'Show SQL' },
            action_id: `show_sql_${traceId}`,
            value: compoundKey,
          },
    );
    if (overrides.table ?? true) {
      elements.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Table' },
        action_id: `override_table_${traceId}`,
        value: compoundKey,
      });
    }
    if (overrides.summary ?? true) {
      elements.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Summary' },
        action_id: `override_summary_${traceId}`,
        value: compoundKey,
      });
    }
    if (overrides.csv ?? true) {
      elements.push({
        type: 'button',
        text: { type: 'plain_text', text: 'CSV' },
        action_id: `override_csv_${traceId}`,
        value: compoundKey,
      });
    }
  }

  return { type: 'actions', elements };
}

// Single source of truth for which output-override buttons a result shape gets.
// Used both by the initial render (pipeline) and by every toggle-restore
// (Hide reasoning / Hide SQL in app.ts) so the two never drift. Derived from the
// persisted result shape (rowCount + columnCount) rather than the full rows so
// the toggle handlers can reconstruct it from ResponseContext.queryResults.
//   - zero rows: nothing to tabulate, summarize, or export → hide all three
//   - single scalar: the value + explanation already IS the prose answer, so
//     Table/CSV/Summary of one cell are all redundant → hide all three
//   - anything else (tables): show all three, minus the button for the view
//     already on screen (no "Table" under a table, no "Summary" under a summary);
//     an unknown view (legacy messages) keeps all three
export function overrideButtonsForResultShape(
  rowCount: number,
  columnCount: number,
  view?: ResultView,
): OverrideButtons {
  if (rowCount === 0) return { table: false, summary: false, csv: false };
  if (rowCount === 1 && columnCount === 1) return { table: false, summary: false, csv: false };
  if (view === 'table') return { table: false };
  if (view === 'summary') return { summary: false };
  return {};
}
