const MAX_TABLE_ROWS = 5;
const MAX_CELL_CHARS = 60;
const MAX_MESSAGE_CHARS = 3500;
const TRUNCATED_SUFFIX = '\n[truncated]';

export interface RenderWhatsAppQueryAnswerInput {
  explanation: string;
  rows: Array<Record<string, unknown>>;
  columnNames: string[];
  totalRows: number;
  assumptions: string[];
  traceId: string;
}

function toAscii(value: string): string {
  return Array.from(value.normalize('NFKD'))
    .filter((char) => char === '\n' || (char >= ' ' && char <= '~'))
    .join('');
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function renderCell(value: unknown): string {
  const oneLine = stringifyValue(value).replace(/\r?\n/g, ' ').replace(/\r/g, ' ');
  const ascii = toAscii(oneLine);
  if (ascii.length <= MAX_CELL_CHARS) return ascii;
  return `${ascii.slice(0, MAX_CELL_CHARS - 3)}...`;
}

function renderRows(input: RenderWhatsAppQueryAnswerInput): string {
  if (input.rows.length === 0) return 'No rows returned.';

  if (input.rows.length === 1 && input.columnNames.length === 1) {
    const columnName = input.columnNames[0];
    return `${renderCell(columnName)}: ${renderCell(input.rows[0][columnName])}`;
  }

  const visibleRows = input.rows.slice(0, MAX_TABLE_ROWS);
  const lines = [
    input.columnNames.map((columnName) => renderCell(columnName)).join(' | '),
    ...visibleRows.map((row) => input.columnNames
      .map((columnName) => renderCell(row[columnName]))
      .join(' | ')),
  ];

  if (input.totalRows > visibleRows.length) {
    lines.push(`Showing ${visibleRows.length} of ${input.totalRows} rows.`);
  }

  return lines.join('\n');
}

function capMessage(text: string): string {
  const ascii = toAscii(text);
  if (ascii.length <= MAX_MESSAGE_CHARS) return ascii;
  return `${ascii.slice(0, MAX_MESSAGE_CHARS - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
}

export function renderWhatsAppQueryAnswer(input: RenderWhatsAppQueryAnswerInput): string {
  const sections = [
    input.explanation.trim(),
    renderRows(input),
  ];

  if (input.assumptions.length > 0) {
    sections.push([
      'Assumptions:',
      ...input.assumptions.map((assumption) => `- ${assumption}`),
    ].join('\n'));
  }

  sections.push(`(trace: ${input.traceId})`);
  return capMessage(sections.filter((section) => section.length > 0).join('\n\n'));
}

export function renderWhatsAppClarification(questions: string[], traceId: string): string {
  const numberedQuestions = questions.map((question, index) => `${index + 1}. ${question}`).join('\n');
  return capMessage(`I need one clarification before I query the warehouse:\n${numberedQuestions}\n\nReply here with the answer. (trace: ${traceId})`);
}

export function renderWhatsAppUnsupported(): string {
  return 'I can only answer text questions in this WhatsApp prototype.';
}

export function renderWhatsAppSafeError(traceId: string): string {
  return capMessage(`I couldn't complete that request safely. Please try again or ask in Slack. (trace: ${traceId})`);
}
