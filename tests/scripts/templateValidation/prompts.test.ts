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
    expect(prompt).toContain('Ask only what the run history itself answers');
    expect(prompt).toContain('Do not ask for rows, counts or values from the tables the models build.');
    expect(prompt).toContain('For a join slot, ask about two or more models or runs together.');
  });
});
