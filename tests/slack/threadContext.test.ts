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

  // The bot posts its status message before the thread is read, so that message
  // is the last one in the thread. Without excludeTs it is the one dropped as
  // "current", and the question being answered stays behind as context.
  describe('excludeTs (the bot status message for this request)', () => {
    it('returns no context for a first question followed only by the status message', () => {
      const messages = [
        { ts: '100.1', bot_id: undefined, text: 'What is total revenue?' },
        { ts: '100.2', bot_id: 'B123', text: 'Got it. Let me get things ready...' },
      ];

      expect(buildThreadContext(messages, 4, { excludeTs: '100.2' })).toEqual([]);
    });

    it('keeps the earlier exchange and drops both the follow-up and its status message', () => {
      const messages = [
        { ts: '100.1', bot_id: undefined, text: 'What is total revenue?' },
        { ts: '100.2', bot_id: 'B123', text: 'Total revenue is $5M' },
        { ts: '100.3', bot_id: undefined, text: 'Break it down by region' },
        { ts: '100.4', bot_id: 'B123', text: 'Got it. Let me get things ready...' },
      ];

      expect(buildThreadContext(messages, 4, { excludeTs: '100.4' })).toEqual([
        { role: 'user', content: 'What is total revenue?' },
        { role: 'assistant', content: 'Total revenue is $5M' },
      ]);
    });

    it('drops the status message even when it is not the last message', () => {
      const messages = [
        { ts: '100.1', bot_id: undefined, text: 'What is total revenue?' },
        { ts: '100.2', bot_id: 'B123', text: 'Reading your question...' },
        { ts: '100.3', bot_id: undefined, text: 'For last month' },
      ];

      expect(buildThreadContext(messages, 4, { excludeTs: '100.2' })).toEqual([
        { role: 'user', content: 'What is total revenue?' },
      ]);
    });

    it('behaves as before when no message has that ts', () => {
      const messages = [
        { ts: '100.1', bot_id: undefined, text: 'question' },
        { ts: '100.2', bot_id: 'B123', text: 'answer' },
        { ts: '100.3', bot_id: undefined, text: 'follow-up' },
      ];

      expect(buildThreadContext(messages, 4, { excludeTs: '999.9' })).toEqual([
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
      ]);
    });
  });
});
