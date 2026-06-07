import type { ModalView } from '@slack/types';

export const OTHER_NOTE_CALLBACK_ID = 'feedback_other_note';
export const OTHER_NOTE_BLOCK_ID = 'feedback_other_note_block';
export const OTHER_NOTE_ACTION_ID = 'feedback_other_note_input';

/**
 * Modal opened when a user picks the "Other" negative-feedback reason. The free-text
 * note is optional. `private_metadata` carries the Slack `channel` plus the
 * `compoundKey` (`${threadTs}_${statusMsgTs}`, the ResponseContext doc key) so the
 * view_submission handler can look up the persisted context when saving the note.
 */
export function buildOtherNoteModal(channel: string, compoundKey: string): ModalView {
  return {
    type: 'modal',
    callback_id: OTHER_NOTE_CALLBACK_ID,
    private_metadata: JSON.stringify({ channel, compoundKey }),
    title: { type: 'plain_text', text: 'Tell us more' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: OTHER_NOTE_BLOCK_ID,
        optional: true,
        label: { type: 'plain_text', text: 'What was off about this answer?' },
        element: {
          type: 'plain_text_input',
          action_id: OTHER_NOTE_ACTION_ID,
          multiline: true,
        },
      },
    ],
  };
}
