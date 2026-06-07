import { describe, it, expect } from 'vitest';
import {
  buildOtherNoteModal,
  OTHER_NOTE_CALLBACK_ID,
  OTHER_NOTE_BLOCK_ID,
  OTHER_NOTE_ACTION_ID,
} from '../../src/slack/feedbackModals.js';

describe('buildOtherNoteModal', () => {
  it('builds a modal carrying channel+compoundKey and a multiline input', () => {
    const view = buildOtherNoteModal('C1', 'T1_S1');
    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe(OTHER_NOTE_CALLBACK_ID);
    expect(view.private_metadata).toBe(JSON.stringify({ channel: 'C1', compoundKey: 'T1_S1' }));
    const input = (view.blocks as any[]).find(b => b.block_id === OTHER_NOTE_BLOCK_ID);
    expect(input.element.type).toBe('plain_text_input');
    expect(input.element.multiline).toBe(true);
    expect(input.element.action_id).toBe(OTHER_NOTE_ACTION_ID);
    expect(input.optional).toBe(true);
  });
});
