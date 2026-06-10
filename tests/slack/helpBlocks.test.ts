import { describe, it, expect } from 'vitest';
import { buildHelpBlocks } from '../../src/slack/helpBlocks.js';

describe('buildHelpBlocks', () => {
  const blocks = buildHelpBlocks();
  const json = JSON.stringify(blocks);

  it('covers asking, clarification, escalation, and the response buttons', () => {
    expect(json).toContain('/anna');
    expect(json).toContain('clarifying question');
    expect(json).toContain('data team');
    expect(json).toContain('feedback');
    expect(json).toContain('the SQL I ran');
  });

  it('contains example questions', () => {
    expect(json).toContain('For example');
  });

  it('stays template-generic (no client-specific vocabulary)', () => {
    // The template boundary applies to help copy too — implementations override examples.
    expect(json).not.toMatch(/ga4|velir|domain methods|dm-website/i);
  });

  it('uses only blocks valid on both message and home surfaces', () => {
    const types = blocks.map((b) => b.type);
    for (const t of types) {
      expect(['header', 'section', 'context', 'divider']).toContain(t);
    }
  });
});
