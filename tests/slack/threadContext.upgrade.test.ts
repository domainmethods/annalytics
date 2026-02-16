import { describe, it, expect } from 'vitest';
import { buildThreadContext } from '../../src/slack/threadContext.js';

describe('buildThreadContext — upgraded options', () => {
  it('keeps last 4 messages verbatim', () => {
    const messages = [
      { bot_id: undefined, text: 'msg1' },
      { bot_id: 'B1', text: 'reply1' },
      { bot_id: undefined, text: 'msg2' },
      { bot_id: 'B1', text: 'reply2' },
      { bot_id: undefined, text: 'current' },
    ];

    const context = buildThreadContext(messages, 4, { summarizeOlder: true });

    expect(context).toHaveLength(4);
    expect(context[0].content).toBe('msg1');
    expect(context[3].content).toBe('reply2');
  });

  it('summarizes older messages when thread > 4 messages', () => {
    const messages = [
      { bot_id: undefined, text: 'Old question about inventory' },
      { bot_id: 'B1', text: 'Here are inventory results' },
      { bot_id: undefined, text: 'Recent msg1' },
      { bot_id: 'B1', text: 'Recent reply1' },
      { bot_id: undefined, text: 'Recent msg2' },
      { bot_id: 'B1', text: 'Recent reply2' },
      { bot_id: undefined, text: 'current question' },
    ];

    const context = buildThreadContext(messages, 4, { summarizeOlder: true });

    // 4 recent + 1 summary = 5
    expect(context).toHaveLength(5);
    expect(context[0].content).toContain('Earlier in this thread');
    expect(context[0].content).toContain('inventory');
  });

  it('strips SQL results from bot responses', () => {
    const messages = [
      { bot_id: undefined, text: 'Show revenue' },
      { bot_id: 'B1', text: 'Here is the data:\n```SELECT SUM(x) FROM t```\nTotal is $5M' },
      { bot_id: undefined, text: 'current' },
    ];

    const context = buildThreadContext(messages, 4, { stripQueryResults: true });

    expect(context[1].content).not.toContain('SELECT');
    expect(context[1].content).toContain('[SQL query shown]');
  });

  it('respects 2K token budget by dropping oldest-first', () => {
    const longText = 'x'.repeat(3000);
    const messages = [
      { bot_id: undefined, text: longText },
      { bot_id: 'B1', text: longText },
      { bot_id: undefined, text: 'short' },
      { bot_id: undefined, text: 'current' },
    ];

    const context = buildThreadContext(messages, 10, {
      summarizeOlder: false,
      maxTokens: 2000,
    });

    const totalChars = context.reduce((sum, m) => sum + m.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(2000 * 4); // 2K tokens * 4 chars/token
  });

  it('preserves backward compatibility with no-options signature', () => {
    const messages = [
      { bot_id: undefined, text: 'question' },
      { bot_id: 'B1', text: 'answer' },
      { bot_id: undefined, text: 'current' },
    ];

    // No-options call
    const context = buildThreadContext(messages, 4);

    expect(context).toHaveLength(2);
    expect(context[0].role).toBe('user');
    expect(context[1].role).toBe('assistant');
  });
});
