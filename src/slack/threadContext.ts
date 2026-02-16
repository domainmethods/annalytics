import type { ThreadMessage } from '../types.js';

interface SlackMessage {
  bot_id?: string;
  text?: string;
}

export interface ThreadContextOptions {
  maxTokens?: number;
  summarizeOlder?: boolean;
  stripQueryResults?: boolean;
}

const MAX_CONTEXT_CHARS = 4000;

export function buildThreadContext(
  messages: SlackMessage[],
  maxMessages: number,
  options: ThreadContextOptions = {},
): ThreadMessage[] {
  if (messages.length <= 1) return [];

  const {
    summarizeOlder = false,
    stripQueryResults = false,
    maxTokens,
  } = options;

  const priorMessages = messages.slice(0, -1);

  let result: ThreadMessage[];

  if (summarizeOlder && priorMessages.length > maxMessages) {
    const older = priorMessages.slice(0, -maxMessages);
    const recent = priorMessages.slice(-maxMessages);
    const summary = summarizeMessages(older);
    result = [
      { role: 'user', content: summary },
      ...recent.map(toThreadMessage),
    ];
  } else {
    result = priorMessages.slice(-maxMessages).map(toThreadMessage);
  }

  if (stripQueryResults) {
    result = result.map(stripSqlResults);
  }

  if (maxTokens) {
    result = enforceTokenBudget(result, maxTokens);
  } else {
    // Default behavior: enforce MAX_CONTEXT_CHARS
    let totalChars = result.reduce((sum, m) => sum + m.content.length, 0);
    while (totalChars > MAX_CONTEXT_CHARS && result.length > 0) {
      const removed = result.shift()!;
      totalChars -= removed.content.length;
    }
  }

  return result;
}

function toThreadMessage(m: SlackMessage): ThreadMessage {
  return {
    role: m.bot_id ? 'assistant' as const : 'user' as const,
    content: m.text || '',
  };
}

function summarizeMessages(messages: SlackMessage[]): string {
  const userMessages = messages.filter(m => !m.bot_id);
  if (userMessages.length === 0) return '';
  return `Earlier in this thread, the user discussed: ${userMessages.map(m => (m.text || '').substring(0, 100)).join('; ')}`;
}

function stripSqlResults(msg: ThreadMessage): ThreadMessage {
  if (msg.role !== 'assistant') return msg;
  const stripped = msg.content
    .replace(/```[\s\S]*?```/g, '[SQL query shown]')
    .replace(/\|.*\|.*\|[\s\S]*?\|.*\|/g, '[Query results table]');
  return { ...msg, content: stripped };
}

function enforceTokenBudget(messages: ThreadMessage[], maxTokens: number): ThreadMessage[] {
  const charBudget = maxTokens * 4; // ~4 chars per token
  let total = messages.reduce((sum, m) => sum + m.content.length, 0);
  const result = [...messages];
  while (total > charBudget && result.length > 1) {
    const removed = result.shift()!;
    total -= removed.content.length;
  }
  return result;
}
