import { describe, expect, it } from 'vitest';
import {
  buildAnswerActionsList,
  buildAnswerFeedbackButtons,
  buildProblemReasonPicker,
} from '../../src/whatsapp/interactive.js';

describe('whatsapp interactive builders', () => {
  it('builds the top-level answer feedback buttons', () => {
    expect(buildAnswerFeedbackButtons({
      okId: 'wa:v1:ok:ctx_ok',
      problemId: 'wa:v1:problem:ctx_problem',
      actionsId: 'wa:v1:actions:ctx_actions',
    })).toEqual({
      kind: 'reply_buttons',
      body: 'Was this answer useful?',
      buttons: [
        { id: 'wa:v1:ok:ctx_ok', title: 'Looks right' },
        { id: 'wa:v1:problem:ctx_problem', title: 'Problem' },
        { id: 'wa:v1:actions:ctx_actions', title: 'Actions' },
      ],
    });
  });

  it('builds a problem reason list with four rows', () => {
    const message = buildProblemReasonPicker({
      wrongNumberId: 'wa:v1:reason_wrong_number:ctx_1',
      wrongDataId: 'wa:v1:reason_wrong_data:ctx_2',
      notAskedId: 'wa:v1:reason_not_asked:ctx_3',
      otherId: 'wa:v1:reason_other:ctx_4',
    });

    expect(message.kind).toBe('list');
    expect(message.buttonText).toBe('Choose reason');
    expect(message.sections[0].rows.map(row => row.title)).toEqual([
      'Wrong number',
      'Wrong data',
      'Not my question',
      'Other',
    ]);
  });

  it('suppresses table and summary actions for single-scalar answers', () => {
    const message = buildAnswerActionsList({
      showReasoningId: 'wa:v1:show_reasoning:ctx_1',
      showSqlId: 'wa:v1:show_sql:ctx_2',
      tableId: 'wa:v1:override_table:ctx_3',
      summaryId: 'wa:v1:override_summary:ctx_4',
      rowCount: 1,
      columnCount: 1,
    });

    expect(message.sections[0].rows.map(row => row.title)).toEqual([
      'Show reasoning',
      'Show SQL',
    ]);
  });

  it('includes table and summary actions for table-shaped answers', () => {
    const message = buildAnswerActionsList({
      showReasoningId: 'wa:v1:show_reasoning:ctx_1',
      showSqlId: 'wa:v1:show_sql:ctx_2',
      tableId: 'wa:v1:override_table:ctx_3',
      summaryId: 'wa:v1:override_summary:ctx_4',
      rowCount: 25,
      columnCount: 4,
    });

    expect(message.sections[0].rows.map(row => row.title)).toEqual([
      'Show reasoning',
      'Show SQL',
      'Table view',
      'Summary view',
    ]);
  });
});
