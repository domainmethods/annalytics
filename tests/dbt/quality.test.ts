import { describe, it, expect } from 'vitest';
import { assessQuality } from '../../src/dbt/quality.js';
import type { TableContext } from '../../src/dbt/types.js';

function makeTable(overrides: Partial<TableContext> = {}): TableContext {
  return {
    name: 'test.table',
    schema: 'test',
    description: 'A test table',
    materialization: 'table',
    columns: [
      { name: 'id', description: 'Primary key', dataType: 'STRING', meta: {} },
      { name: 'name', description: 'User name', dataType: 'STRING', meta: {} },
      { name: 'email', description: 'Email address', dataType: 'STRING', meta: {} },
    ],
    sampleDDL: '',
    dependsOn: [],
    tags: [],
    ...overrides,
  };
}

describe('assessQuality', () => {
  it('returns high tier when >70% columns have descriptions', () => {
    const result = assessQuality(makeTable()); // 3/3 = 100%
    expect(result.qualityTier).toBe('high');
    expect(result.columnDescriptionCoverage).toBe(1);
    expect(result.descriptionPresent).toBe(true);
  });

  it('returns medium tier when 30-70% columns have descriptions', () => {
    const table = makeTable({
      columns: [
        { name: 'id', description: 'Primary key', dataType: 'STRING', meta: {} },
        { name: 'name', description: '', dataType: 'STRING', meta: {} },
        { name: 'email', description: '', dataType: 'STRING', meta: {} },
      ],
    }); // 1/3 = 33%
    const result = assessQuality(table);
    expect(result.qualityTier).toBe('medium');
  });

  it('returns low tier when <30% columns have descriptions', () => {
    const table = makeTable({
      columns: [
        { name: 'id', description: '', dataType: 'STRING', meta: {} },
        { name: 'name', description: '', dataType: 'STRING', meta: {} },
        { name: 'email', description: '', dataType: 'STRING', meta: {} },
        { name: 'region', description: 'geo', dataType: 'STRING', meta: {} },
      ],
    }); // 1/4 = 25%
    const result = assessQuality(table);
    expect(result.qualityTier).toBe('low');
  });

  it('detects missing table description', () => {
    const result = assessQuality(makeTable({ description: '' }));
    expect(result.descriptionPresent).toBe(false);
  });

  it('treats whitespace-only descriptions as empty', () => {
    const table = makeTable({
      description: '   ',
      columns: [
        { name: 'id', description: '  ', dataType: 'STRING', meta: {} },
      ],
    });
    const result = assessQuality(table);
    expect(result.descriptionPresent).toBe(false);
    expect(result.columnDescriptionCoverage).toBe(0);
    expect(result.qualityTier).toBe('low');
  });
});
