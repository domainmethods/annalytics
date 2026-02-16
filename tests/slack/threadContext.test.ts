import { describe, it, expect } from 'vitest';
import { buildThreadContext } from '../../src/slack/threadContext.js';

describe('buildThreadContext', () => {
  it('extracts last 4 messages as user/assistant pairs', () => {
    const messages = [
      { bot_id: undefined, text: 'Show me revenue' },
      { bot_id: 'B123', text: 'Total revenue is $5M\n```SELECT SUM(...)```' },
      { bot_id: undefined, text: 'Break it down by region' },
      { bot_id: 'B123', text: 'Here is the breakdown...' },
      { bot_id: undefined, text: 'Now by month' },
    ];

    const context = buildThreadContext(messages, 4);
    // Excludes the current message (last), takes last 4 of remaining
    expect(context).toHaveLength(4);
    // messages[0] has bot_id: undefined → 'user'
    expect(context[0].role).toBe('user');
    expect(context[3].role).toBe('assistant');
    expect(context[3].content).toBe('Here is the breakdown...');
  });

  it('returns empty array for single message (no context)', () => {
    const messages = [{ bot_id: undefined, text: 'First question' }];
    const context = buildThreadContext(messages, 4);
    expect(context).toHaveLength(0);
  });

  it('assigns correct roles', () => {
    const messages = [
      { bot_id: undefined, text: 'question' },
      { bot_id: 'B123', text: 'answer' },
      { bot_id: undefined, text: 'follow-up' },
    ];
    const context = buildThreadContext(messages, 4);
    // Excludes last message ('follow-up'), 2 prior messages remain
    expect(context).toHaveLength(2);
    expect(context[0].role).toBe('user');
    expect(context[1].role).toBe('assistant');
  });

  it('truncates total context to 4000 characters when messages exceed limit', () => {
    const longText = 'x'.repeat(2000);
    const messages = [
      { bot_id: undefined, text: longText },  // 2000 chars
      { bot_id: 'B123', text: longText },      // 2000 chars
      { bot_id: undefined, text: longText },   // 2000 chars — would push total to 6000
      { bot_id: undefined, text: 'current' },  // excluded (current message)
    ];
    const context = buildThreadContext(messages, 10);
    // Total of 3 prior messages = 6000 chars > 4000
    // Should drop oldest messages first until under limit
    const totalChars = context.reduce((sum, m) => sum + m.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(4000);
    // Should have dropped the oldest message (messages[0])
    expect(context.length).toBeLessThan(3);
  });
});
