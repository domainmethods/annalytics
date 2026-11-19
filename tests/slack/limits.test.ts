import { describe, expect, it } from 'vitest';
import type { KnownBlock, SectionBlock } from '@slack/types';
import { buildSingleValueBlocks, buildTableBlocks } from '../../src/slack/blocks.js';
import { buildSqlBlocks, SQL_BLOCK_PREFIX } from '../../src/slack/sqlBlocks.js';
import { buildEscalationBlocks } from '../../src/slack/escalationBlocks.js';
import {
  MAX_SQL_SECTIONS,
  SECTION_TEXT_LIMIT,
  TABLE_ROW_LIMIT,
  TABLE_TEXT_LIMIT,
  sqlSections,
} from '../../src/slack/limits.js';
import type { ResponseContext } from '../../src/types.js';

interface TableBlockShape {
  type: 'table';
  rows: Array<Array<{ text: string }>>;
}

const SLACK_MESSAGE_BLOCK_LIMIT = 50;

function expectWithinSlackLimits(blocks: KnownBlock[]): void {
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks.length).toBeLessThanOrEqual(SLACK_MESSAGE_BLOCK_LIMIT);
  for (const block of blocks as Array<KnownBlock | TableBlockShape>) {
    if (block.type === 'section') {
      expect((block as SectionBlock).text!.text.length).toBeLessThanOrEqual(SECTION_TEXT_LIMIT);
    }
    if (block.type === 'table') {
      const table = block as TableBlockShape;
      expect(table.rows.length).toBeLessThanOrEqual(TABLE_ROW_LIMIT);
      const chars = table.rows.flat().reduce((n, cell) => n + cell.text.length, 0);
      expect(chars).toBeLessThanOrEqual(TABLE_TEXT_LIMIT);
    }
  }
}

function sqlFromSections(blocks: KnownBlock[]): string {
  return (blocks as SectionBlock[]).map(b => b.text!.text.slice(3, -3)).join('');
}

function escalationInput(overrides: Partial<Parameters<typeof buildEscalationBlocks>[0]> = {}) {
  return { userQuestion: 'q', channelName: 'c', threadLink: 'url', stuckDescription: 's', ...overrides };
}

describe('SQL sections', () => {
  it.each([2977, 2978, 2994, 2995, 6000])('bounds SQL of length %i', length => {
    const sql = 'x'.repeat(length);
    expectWithinSlackLimits(buildSqlBlocks({ generatedSql: sql } as ResponseContext));
    expectWithinSlackLimits(buildEscalationBlocks(escalationInput({ bestGuessSql: sql })));
  });

  it('preserves the full SQL across sections', () => {
    const sql = 'x'.repeat(6000);
    expect(sqlFromSections(buildSqlBlocks({ generatedSql: sql } as ResponseContext))).toBe(sql);
  });

  it('splits multi-line SQL on line boundaries', () => {
    const sql = Array.from({ length: 300 }, (_, i) => `SELECT column_${i} FROM t`).join('\n');
    const blocks = sqlSections(sql) as SectionBlock[];
    expect(blocks.length).toBeGreaterThan(1);
    expectWithinSlackLimits(blocks);
    for (const block of blocks.slice(0, -1)) {
      expect(block.text!.text.endsWith('\n```')).toBe(true);
    }
    expect(sqlFromSections(blocks)).toBe(sql);
  });

  it('keeps the SQL block-id prefix on every chunk so the toggle can find them', () => {
    const blocks = buildSqlBlocks({ generatedSql: 'x'.repeat(6000) } as ResponseContext) as SectionBlock[];
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) expect(block.block_id?.startsWith(SQL_BLOCK_PREFIX)).toBe(true);
  });
});

describe('SQL longer than the section cap', () => {
  const sql = 'x'.repeat(150_000);

  it('caps SQL sections and ends with an explicit truncation note', () => {
    const blocks = buildSqlBlocks({ generatedSql: sql } as ResponseContext) as SectionBlock[];
    expect(blocks).toHaveLength(MAX_SQL_SECTIONS + 1);
    expectWithinSlackLimits(blocks);
    expect(blocks.at(-1)!.text!.text).toContain('SQL truncated for Slack');
    expect(blocks.at(-1)!.text!.text).toContain('150,000');
    for (const block of blocks) expect(block.block_id?.startsWith(SQL_BLOCK_PREFIX)).toBe(true);
  });

  it('keeps the escalation message under the block limit', () => {
    const long = 'q'.repeat(300_000);
    expectWithinSlackLimits(buildEscalationBlocks(escalationInput({
      userQuestion: long,
      stuckDescription: long,
      bestGuessSql: sql,
    })));
  });
});

describe('single value', () => {
  it('bounds a very long value without dropping the closing bold marker', () => {
    const blocks = buildSingleValueBlocks('v'.repeat(10_000), 'h'.repeat(10_000)) as SectionBlock[];
    expectWithinSlackLimits(blocks);
    expect(blocks[0].text!.text).toMatch(/^\*v+…\*\n/);
  });
});

describe('native table limits', () => {
  it.each([20, 21])('bounds results with %i columns', columnCount => {
    const columns = Array.from({ length: columnCount }, (_, i) => `measure_${i}`);
    const rows = Array.from({ length: 20 }, () => Object.fromEntries(columns.map(c => [c, 42])));
    expectWithinSlackLimits(buildTableBlocks(rows, columns));
  });

  // The one-character header cell pushes 10,000 into the 10,001-character overflow case.
  it.each([TABLE_TEXT_LIMIT - 1, TABLE_TEXT_LIMIT])('bounds a native table whose cell text is %i chars', length => {
    expectWithinSlackLimits(buildTableBlocks([{ c: 'x'.repeat(length) }], ['c']));
  });

  it.each([TABLE_ROW_LIMIT - 1, TABLE_ROW_LIMIT])('bounds %i data rows', rowCount => {
    expectWithinSlackLimits(buildTableBlocks(Array.from({ length: rowCount }, () => ({ c: 1 })), ['c']));
  });

  it('points truncated results to CSV', () => {
    expect(JSON.stringify(buildTableBlocks([{ c: 'x'.repeat(TABLE_TEXT_LIMIT) }], ['c']))).toContain('CSV export');
  });
});

describe('escalation sections', () => {
  it('bounds long questions and descriptions', () => {
    const long = SECTION_TEXT_LIMIT + 1;
    expectWithinSlackLimits(buildEscalationBlocks(escalationInput({
      userQuestion: 'q'.repeat(long),
      stuckDescription: 's'.repeat(long),
    })));
  });
});
