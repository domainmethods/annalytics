import { describe, expect, it } from 'vitest';
import { NODE_IDS } from '../../../src/agents/nodeProfiles.js';
import { draftPrompt, labelPrompt, templateRules } from '../../../scripts/template-validation/prompts.js';

const SQL_RULE = 'Use BigQuery SELECT SQL';
const PLAIN_LANGUAGE_NODES = ['slackIntake', 'followUpClassifier', 'metaQuestion', 'chart', 'dbtStatus'] as const;
const TEMPLATE_RULE_NODES = [
  'sqlGenerator', 'supervisor', 'summaryOverride', 'clarification', 'ambiguityClassifier', 'discrepancy', 'teachingCandidate',
] as const;

describe('draftPrompt', () => {
  it('assigns every node to exactly one rule set', () => {
    expect([...PLAIN_LANGUAGE_NODES, ...TEMPLATE_RULE_NODES].sort()).toEqual([...NODE_IDS].sort());
  });

  it.each(PLAIN_LANGUAGE_NODES)(
    'asks for plain-language %s messages with no SQL',
    (node) => {
      const prompt = draftPrompt(node, ['simple'], '', '');
      expect(prompt).not.toContain(SQL_RULE);
      expect(prompt).toContain('do not include SQL');
      expect(prompt).toContain('Omit emails, project IDs and private data.');
    },
  );

  it.each(TEMPLATE_RULE_NODES)(
    'keeps the shared template rules for %s',
    (node) => {
      expect(draftPrompt(node, ['simple'], '', '')).toContain(templateRules);
    },
  );
});

describe('labelPrompt', () => {
  it.each(PLAIN_LANGUAGE_NODES)('keeps the shared template rules for %s labels', (node) => {
    expect(labelPrompt(node, [], '')).toContain(templateRules);
  });
});

describe('dbtStatus draft instruction', () => {
  it('keeps drafted questions to what run history answers', () => {
    const prompt = draftPrompt('dbtStatus', ['join'], '', '');
    expect(prompt).toContain('Do not ask for rows, counts or values from the tables the models build.');
  });
});

describe('ambiguityClassifier draft instruction', () => {
  it('keeps ambiguities open, hides the type and keeps SQL out of user turns', () => {
    const prompt = draftPrompt('ambiguityClassifier', ['simple'], '', '');
    expect(prompt).toContain('the thread context must not answer the clarifying question');
    expect(prompt).toContain('without naming or hinting at who resolves them');
    expect(prompt).toContain('put any SQL only in assistant turns');
  });
});

describe('draft examples', () => {
  it('shows retained items as style examples only when there are any', () => {
    expect(draftPrompt('slackIntake', ['simple'], '', '')).not.toContain('Match the structure');
    const prompt = draftPrompt('slackIntake', ['simple'], '', '', [{ category: 'simple', text: 'An example seed' }]);
    expect(prompt).toContain('Match the structure, style and difficulty of these existing items');
    expect(prompt).toContain('An example seed');
  });
});
