export interface WhatsAppReplyButton {
  id: string;
  title: string;
}

export interface WhatsAppListRow {
  id: string;
  title: string;
  description?: string;
}

export interface WhatsAppListSection {
  title: string;
  rows: WhatsAppListRow[];
}

export type WhatsAppInteractiveMessage =
  | {
    kind: 'reply_buttons';
    body: string;
    footer?: string;
    buttons: WhatsAppReplyButton[];
  }
  | {
    kind: 'list';
    body: string;
    footer?: string;
    buttonText: string;
    sections: WhatsAppListSection[];
  };

export function buildAnswerFeedbackButtons(input: {
  okId: string;
  problemId: string;
  actionsId: string;
}): WhatsAppInteractiveMessage {
  return {
    kind: 'reply_buttons',
    body: 'Was this answer useful?',
    buttons: [
      { id: input.okId, title: 'Looks right' },
      { id: input.problemId, title: 'Problem' },
      { id: input.actionsId, title: 'Actions' },
    ],
  };
}

export function buildProblemReasonPicker(input: {
  wrongNumberId: string;
  wrongDataId: string;
  notAskedId: string;
  otherId: string;
}): WhatsAppInteractiveMessage {
  return {
    kind: 'list',
    body: 'What was wrong with this answer?',
    buttonText: 'Choose reason',
    sections: [{
      title: 'Feedback',
      rows: [
        { id: input.wrongNumberId, title: 'Wrong number' },
        { id: input.wrongDataId, title: 'Wrong data' },
        { id: input.notAskedId, title: 'Not my question' },
        { id: input.otherId, title: 'Other' },
      ],
    }],
  };
}

export function buildAnswerActionsList(input: {
  showReasoningId: string;
  showSqlId: string;
  tableId: string;
  summaryId: string;
  rowCount: number;
  columnCount: number;
}): WhatsAppInteractiveMessage {
  const rows: WhatsAppListRow[] = [
    { id: input.showReasoningId, title: 'Show reasoning' },
    { id: input.showSqlId, title: 'Show SQL' },
  ];

  if (input.rowCount > 0 && !(input.rowCount === 1 && input.columnCount === 1)) {
    rows.push(
      { id: input.tableId, title: 'Table view' },
      { id: input.summaryId, title: 'Summary view' },
    );
  }

  return {
    kind: 'list',
    body: 'What would you like to see?',
    buttonText: 'Open actions',
    sections: [{ title: 'Answer actions', rows }],
  };
}
