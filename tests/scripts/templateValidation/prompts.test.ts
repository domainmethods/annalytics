import { describe, expect, it } from 'vitest';
import { draftPrompt, labelPrompt, templateRules } from '../../../scripts/template-validation/prompts.js';

const SQL_RULE = 'Use BigQuery SELECT SQL';

describe('draftPrompt', () => {
  it.each(['slackIntake', 'followUpClassifier', 'metaQuestion', 'chart', 'dbtStatus'] as const)(
    'asks for plain-language %s messages with no SQL',
    (node) => {
      const prompt = draftPrompt(node, ['simple'], '', '');
      expect(prompt).not.toContain(SQL_RULE);
      expect(prompt).toContain('do not include SQL');
      expect(prompt).toContain('Omit emails, project IDs and private data.');
    },
  );

  it.each(['sqlGenerator', 'summaryOverride', 'clarification', 'ambiguityClassifier', 'discrepancy'] as const)(
    'keeps the shared template rules for %s',
    (node) => {
      expect(draftPrompt(node, ['simple'], '', '')).toContain(templateRules);
    },
  );
});

describe('labelPrompt', () => {
  it('keeps the shared template rules for message-like nodes', () => {
    expect(labelPrompt('slackIntake', [], '')).toContain(templateRules);
  });
});
