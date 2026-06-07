import type { KnownBlock, ActionsBlock, SectionBlock, TableBlock, RawTextElement } from '@slack/types';

/** Safely format a BigQuery cell value. Order matters: real JS Date before the
 *  `{value}` unwrap, because a Date is an object whose `.value` is undefined and
 *  would otherwise fall through to JSON.stringify and render a quoted ISO string. */
export function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object') {
    const wrapped = (val as { value?: unknown }).value;
    return wrapped != null ? String(wrapped) : JSON.stringify(val);
  }
  return String(val);
}

// Leading blocks for an answer derived from assumptions: a context line listing
// the assumptions plus a "refine" actions block. Single source of truth shared
// by the initial render (pipeline) and the Table/Summary override re-renders so
// the refine affordance survives an override click. Returns [] when there are no
// assumptions. The context block carries text in `elements` (not a top-level
// `text`) — clients/tests rely on that exact shape.
export function buildAssumptionBlocks(assumptions: string[], traceId: string): KnownBlock[] {
  if (!assumptions || assumptions.length === 0) return [];
  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🔍 *Assumptions:* ${assumptions.join(', ')}` }],
    } as KnownBlock,
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Wrong assumptions? Click to refine' },
        action_id: 'refine_assumptions',
        value: traceId,
      }],
    } as KnownBlock,
  ];
}

export function buildSingleValueBlocks(value: string, headline: string): KnownBlock[] {
  // Section only — the caller (buildResponseBlocks) appends assumptions and the
  // feedback actions row, uniform with every other content builder. The value is
  // the authoritative BigQuery cell (bold); the headline is the one-line label.
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${value}*\n${headline}` },
    } as SectionBlock,
  ];
}

const NATIVE_TABLE_MAX_COLS = 20; // Slack native table block hard cap.

export function buildTableBlocks(
  rows: Record<string, unknown>[],
  columnNames: string[],
): KnownBlock[] {
  // Slack's native table caps at 20 columns; wide results degrade to the legacy
  // monospace renderer rather than dropping columns.
  if (columnNames.length > NATIVE_TABLE_MAX_COLS) {
    return buildCodeBlockTable(rows, columnNames);
  }
  const cell = (text: string): RawTextElement => ({
    type: 'raw_text',
    // raw_text requires length >= 1; empty cells render as an em dash.
    text: text.length > 0 ? text : '—',
  });
  const header = columnNames.map((c) => cell(c));
  const dataRows = rows.map((row) => columnNames.map((col) => cell(formatValue(row[col]))));
  return [{ type: 'table', rows: [header, ...dataRows] } satisfies TableBlock];
}

// Legacy monospace renderer, retained as the >20-column fallback.
function buildCodeBlockTable(
  rows: Record<string, unknown>[],
  columnNames: string[],
): KnownBlock[] {
  const widths = columnNames.map((col) =>
    Math.max(col.length, ...rows.map((r) => formatValue(r[col]).length)),
  );
  const header = columnNames.map((c, i) => c.padEnd(widths[i])).join(' | ');
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-');
  const dataRows = rows.map((row) =>
    columnNames.map((col, i) => formatValue(row[col]).padEnd(widths[i])).join(' | '),
  );
  const tableText = [header, separator, ...dataRows].join('\n');
  return [{ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`\n${tableText}\n\`\`\`` } } as SectionBlock];
}

export function buildZeroRowBlocks(
  assumptions: string[],
): KnownBlock[] {
  const filterList = assumptions.length > 0
    ? `\n*Filters applied:* ${assumptions.join(', ')}`
    : '';

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
//   - anything else (tables): show all three
export function overrideButtonsForResultShape(
  rowCount: number,
  columnCount: number,
): OverrideButtons {
  if (rowCount === 0) return { table: false, summary: false, csv: false };
  if (rowCount === 1 && columnCount === 1) return { table: false, summary: false, csv: false };
  return {};
}
