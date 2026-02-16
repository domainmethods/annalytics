import { describe, it, expect } from 'vitest';
import {
  buildEscalationBlocks,
  buildUserWaitingBlocks,
  buildBestEffortCaveatBlocks,
  buildEscalationResolvedBlocks,
  buildEscalationReminderBlocks,
} from '../../src/slack/escalationBlocks.js';

describe('buildEscalationBlocks', () => {
  it('includes user question, channel, stuck description, and action hint', () => {
    const blocks = buildEscalationBlocks({
      userQuestion: 'What is total revenue?',
      channelName: '#analytics',
      threadLink: 'https://slack.com/thread/123',
      stuckDescription: 'Two candidate tables: fct_orders and fct_subscriptions',
    });

    const text = blocks.map((b) => JSON.stringify(b)).join(' ');
    expect(text).toContain('What is total revenue?');
    expect(text).toContain('#analytics');
    expect(text).toContain('https://slack.com/thread/123');
    expect(text).toContain('Two candidate tables');
    expect(text).toContain('reply with guidance');
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  it('includes best guess SQL block when provided', () => {
    const blocks = buildEscalationBlocks({
      userQuestion: 'What is total revenue?',
      channelName: '#analytics',
      threadLink: 'https://slack.com/thread/123',
      stuckDescription: 'Uncertain about date filter',
      bestGuessSql: 'SELECT SUM(revenue) FROM fct_orders',
    });

    const text = blocks.map((b) => JSON.stringify(b)).join(' ');
    expect(text).toContain('SELECT SUM(revenue) FROM fct_orders');
  });

  it('omits SQL block when no best guess', () => {
    const blocks = buildEscalationBlocks({
      userQuestion: 'What is total revenue?',
      channelName: '#analytics',
      threadLink: 'https://slack.com/thread/123',
      stuckDescription: 'Could not generate a reliable query',
    });

    const text = blocks.map((b) => JSON.stringify(b)).join(' ');
    expect(text).not.toContain('```');
  });
});

describe('buildUserWaitingBlocks', () => {
  it('returns waiting message', () => {
    const blocks = buildUserWaitingBlocks();
    const text = blocks.map((b) => JSON.stringify(b)).join(' ');
    expect(text).toContain("I've asked the data team");
    expect(text).toContain("I'll reply here when I have the answer");
  });
});

describe('buildBestEffortCaveatBlocks', () => {
  it('includes caveat text and supervisor notes', () => {
    const blocks = buildBestEffortCaveatBlocks('Date filter may be incorrect');
    const text = blocks.map((b) => JSON.stringify(b)).join(' ');
    expect(text).toContain('Date filter may be incorrect');
    expect(text).toContain('verif');
  });
});

describe('buildEscalationResolvedBlocks', () => {
  it('includes human response for park_wait', () => {
    const blocks = buildEscalationResolvedBlocks(
      'Use fct_orders with status=completed',
      'park_wait',
    );
    const text = blocks.map((b) => JSON.stringify(b)).join(' ');
    expect(text).toContain('Use fct_orders with status=completed');
    expect(text).toContain('data team');
  });

  it('includes human response for best_effort_verify', () => {
    const blocks = buildEscalationResolvedBlocks(
      'Looks correct!',
      'best_effort_verify',
    );
    const text = blocks.map((b) => JSON.stringify(b)).join(' ');
    expect(text).toContain('Looks correct!');
  });
});

describe('buildEscalationReminderBlocks', () => {
  it('includes original question and elapsed time', () => {
    const blocks = buildEscalationReminderBlocks({
      escalationId: 'esc-123',
      originalQuestion: 'What is total revenue?',
      elapsed: '45 minutes',
    });
    const text = blocks.map((b) => JSON.stringify(b)).join(' ');
    expect(text).toContain('What is total revenue?');
    expect(text).toContain('45 minutes');
    expect(text).toContain('still waiting');
  });
});
