import { describe, it, expect } from 'vitest';
import {
  buildClarificationBlocks,
  buildCancelFailedBlocks,
  buildPendingClarificationBlocks,
  CANCEL_FAILED_TEXT,
} from '../../src/slack/clarificationBlocks.js';

describe('buildClarificationBlocks', () => {
  const options = {
    clarificationId: 'clarify-123',
    clarifyingQuestions: [
      'Are you looking at gross or net revenue?',
      'What time period — this month or all time?',
    ],
    originalQuestion: 'Show me revenue',
  };

  it('builds blocks with a header text introducing the follow-up', () => {
    const blocks = buildClarificationBlocks(options);

    expect(blocks[0].type).toBe('section');
    expect(blocks[0].text.text).toContain('make sure I get this right');
  });

  it('includes a section for each clarifying question', () => {
    const blocks = buildClarificationBlocks(options);

    const questionBlocks = blocks.filter(
      (b: any) => b.type === 'section' && b.text.text.includes('*'),
    );

    expect(questionBlocks).toHaveLength(2);
    expect(questionBlocks[0].text.text).toContain('1.');
    expect(questionBlocks[0].text.text).toContain('gross or net revenue');
    expect(questionBlocks[1].text.text).toContain('2.');
  });

  it('numbers each clarifying question sequentially', () => {
    const blocks = buildClarificationBlocks(options);

    const questionBlocks = blocks.filter(
      (b: any) => b.type === 'section' && b.text.text.startsWith('*'),
    );

    expect(questionBlocks[0].text.text).toMatch(/^\*1\./);
    expect(questionBlocks[1].text.text).toMatch(/^\*2\./);
  });

  it('includes a text section for free-text fallback', () => {
    const blocks = buildClarificationBlocks(options);

    const contextBlock = blocks.find((b: any) => b.type === 'context');
    expect(contextBlock).toBeDefined();
    expect(contextBlock.elements[0].text).toContain('Reply with your choices');
  });

  it('includes a cancel button carrying the clarificationId', () => {
    const blocks = buildClarificationBlocks({
      clarificationId: 'clar_1',
      clarifyingQuestions: ['Which sessions should I include?'],
      originalQuestion: 'show me sessions',
    });

    const actions = blocks.find((b: any) => b.type === 'actions');
    expect(actions).toBeDefined();
    expect((actions as any).elements[0].action_id).toBe('clarification_cancel');
    expect((actions as any).elements[0].value).toBe('clar_1');
  });
});

describe('buildPendingClarificationBlocks', () => {
  it('shows the original question and the same cancel action', () => {
    const blocks = buildPendingClarificationBlocks({
      clarificationId: 'clar_1',
      originalQuestion: 'show me sessions',
    });

    expect(JSON.stringify(blocks)).toContain('show me sessions');
    const actions = blocks.find((b: any) => b.type === 'actions');
    expect(actions).toBeDefined();
    expect((actions as any).elements[0].action_id).toBe('clarification_cancel');
    expect((actions as any).elements[0].value).toBe('clar_1');
  });
});

describe('buildCancelFailedBlocks', () => {
  it('carries the failure copy and a retry button with the clarificationId', () => {
    const blocks = buildCancelFailedBlocks('clar_9');
    const json = JSON.stringify(blocks);
    expect(json).toContain(CANCEL_FAILED_TEXT);
    expect(json).toContain('"action_id":"clarification_cancel"');
    expect(json).toContain('"value":"clar_9"');
  });
});
