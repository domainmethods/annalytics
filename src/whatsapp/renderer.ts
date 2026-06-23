const MAX_TABLE_ROWS = 5;
const MAX_CELL_CHARS = 60;
const MAX_MESSAGE_CHARS = 3500;
const TRUNCATED_SUFFIX = '\n[truncated]';

const ASCII_REPLACEMENTS: Record<string, string> = {
  '\u00a3': 'GBP ',
  '\u00a5': 'JPY ',
  '\u00b1': '+/-',
  '\u00d7': 'x',
  '\u00f7': '/',
  '\u2013': '-',
  '\u2014': '-',
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u2026': '...',
  '\u20ac': 'EUR ',
  '\u2212': '-',
  '\u2264': '<=',
  '\u2265': '>=',
};

export interface RenderWhatsAppQueryAnswerInput {
  explanation: string;
  rows: Array<Record<string, unknown>>;
  columnNames: string[];
  totalRows: number;
  assumptions: string[];
  traceId: string;
}

function toAscii(value: string): string {
  const transliterated = Array.from(value)
    .map((char) => ASCII_REPLACEMENTS[char] ?? char)
    .join('');
  return Array.from(transliterated.normalize('NFKD'))
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
  const oneLine = stringifyValue(value)
    .replace(/\r?\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\s*\|\s*/g, ' / ');
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

function capMessageWithFooter(body: string, footer: string, separator = '\n\n'): string {
  const asciiBody = toAscii(body);
  const asciiFooter = toAscii(footer);
  const full = asciiBody.length > 0 ? `${asciiBody}${separator}${asciiFooter}` : asciiFooter;
  if (full.length <= MAX_MESSAGE_CHARS) return full;

  const suffix = `${TRUNCATED_SUFFIX}${separator}${asciiFooter}`;
  const bodyLimit = MAX_MESSAGE_CHARS - suffix.length;
  if (bodyLimit <= 0) return capMessage(asciiFooter);
  return `${asciiBody.slice(0, bodyLimit)}${suffix}`;
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

  return capMessageWithFooter(
    sections.filter((section) => section.length > 0).join('\n\n'),
    `(trace: ${input.traceId})`,
  );
}

export function renderWhatsAppClarification(questions: string[], traceId: string): string {
  const numberedQuestions = questions.map((question, index) => `${index + 1}. ${question}`).join('\n');
  return capMessageWithFooter(
    `I need one clarification before I query the warehouse:\n${numberedQuestions}\n\nReply here with the answer.`,
    `(trace: ${traceId})`,
    ' ',
  );
}

export function renderWhatsAppUnsupported(): string {
  return 'I can only answer text questions in this WhatsApp prototype.';
}

export function renderWhatsAppSafeError(traceId: string): string {
  return capMessageWithFooter(
    "I couldn't complete that request safely. Please try again or ask in Slack.",
    `(trace: ${traceId})`,
    ' ',
  );
}

export function renderWhatsAppFeedbackAck(kind: 'positive' | 'negative'): string {
  return kind === 'positive'
    ? 'Got it. I marked this answer as useful.'
    : 'Got it. I logged this feedback for review.';
}

export function renderWhatsAppExpiredAction(): string {
  return 'I cannot find that answer context anymore. Ask the question again if you want me to re-check it.';
}

export function renderWhatsAppSql(sql: string, traceId: string): string {
  return capMessageWithFooter(`SQL:\n${sql}`, `(trace: ${traceId})`);
}

export function renderWhatsAppReasoning(input: {
  explanation: string;
  assumptions: string[];
  reasoningChain: string;
  supervisorNotes?: string;
  groundingCitations: Array<{ sourceFile: string; quote?: string }>;
  traceId: string;
}): string {
  const sections = [
    'Reasoning',
    input.explanation.trim(),
  ];

  if (input.reasoningChain.trim()) {
    sections.push(`Steps:\n${input.reasoningChain.trim()}`);
  }

  if (input.assumptions.length > 0) {
    sections.push([
      'Assumptions:',
      ...input.assumptions.map((assumption) => `- ${assumption}`),
    ].join('\n'));
  }

  if (input.supervisorNotes?.trim()) {
    sections.push(`Review:\n${input.supervisorNotes.trim()}`);
  }

  if (input.groundingCitations.length > 0) {
    sections.push([
      'Sources:',
      ...input.groundingCitations.map((citation) => `- ${citation.sourceFile}`),
    ].join('\n'));
  }

  return capMessageWithFooter(sections.join('\n\n'), `(trace: ${input.traceId})`);
}
