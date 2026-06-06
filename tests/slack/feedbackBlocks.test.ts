import { describe, it, expect } from 'vitest';
import {
  buildFeedbackReasonBlocks,
  buildFeedbackAckBlocks,
  feedbackReasonById,
  FEEDBACK_REASONS,
  FEEDBACK_REASON_PREFIX,
} from '../../src/slack/feedbackBlocks.js';

describe('buildFeedbackReasonBlocks', () => {
  const compoundKey = '1700000000.000100_1700000000.000200';

  it('renders one button per reason with prefixed action_id and the compound key as value', () => {
    const blocks = buildFeedbackReasonBlocks(compoundKey);
    const actions = blocks.find(b => b.type === 'actions') as any;
    expect(actions).toBeDefined();
    expect(actions.elements).toHaveLength(FEEDBACK_REASONS.length);

    actions.elements.forEach((el: any, i: number) => {
      expect(el.type).toBe('button');
      expect(el.action_id).toMatch(new RegExp(`^${FEEDBACK_REASON_PREFIX}`));
      expect(el.value).toBe(compoundKey);
      // The visible label is load-bearing — a later task embeds reason.label into
      // the human-facing escalation card, so a label/id drift must fail here.
      expect(el.text.text).toBe(FEEDBACK_REASONS[i].label);
    });
  });

  it('encodes each reason id in its action_id', () => {
    const blocks = buildFeedbackReasonBlocks(compoundKey);
    const actions = blocks.find(b => b.type === 'actions') as any;
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).toEqual(FEEDBACK_REASONS.map(r => `${FEEDBACK_REASON_PREFIX}${r.id}`));
  });

  it('includes a prompt section', () => {
    const blocks = buildFeedbackReasonBlocks(compoundKey);
    expect(blocks.some(b => b.type === 'section')).toBe(true);
  });
});

describe('feedbackReasonById', () => {
  it('maps the two data-correctness reasons to escalate', () => {
    expect(feedbackReasonById('wrong_number')?.route).toBe('escalate');
    expect(feedbackReasonById('wrong_data')?.route).toBe('escalate');
  });

  it('maps not_asked to refine and other to record', () => {
    expect(feedbackReasonById('not_asked')?.route).toBe('refine');
    expect(feedbackReasonById('other')?.route).toBe('record');
  });

  it('returns undefined for an unknown id', () => {
    expect(feedbackReasonById('nope')).toBeUndefined();
  });
});

describe('buildFeedbackAckBlocks', () => {
  it('wraps the message in a single section block', () => {
    const blocks = buildFeedbackAckBlocks('✅ Flagged for the data team.');
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as any).text.text).toBe('✅ Flagged for the data team.');
  });
});
