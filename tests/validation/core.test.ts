import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStatic = vi.fn();
const mockAst = vi.fn();
const mockDryRun = vi.fn();

vi.mock('../../src/validation/staticAnalysis.js', () => ({
  staticAnalysis: (...a: unknown[]) => mockStatic(...a),
}));
vi.mock('../../src/validation/astValidation.js', () => ({
  astValidation: (...a: unknown[]) => mockAst(...a),
}));
vi.mock('../../src/validation/dryRun.js', () => ({
  dryRunValidation: (...a: unknown[]) => mockDryRun(...a),
}));

import { runCoreValidation } from '../../src/validation/core.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockStatic.mockReturnValue({ valid: true, layer: 'L1-static' });
  mockAst.mockReturnValue({ valid: true, layer: 'L2-ast' });
  mockDryRun.mockResolvedValue({ valid: true, layer: 'L3-dryrun', bytesProcessed: 1000 });
});

describe('runCoreValidation', () => {
  it('returns l1/l2/l3 records and bytes when L1 and L3 pass', async () => {
    const out = await runCoreValidation('SELECT 1', 0);
    expect(out.blocked).toBeNull();
    expect(out.blockedLayer).toBeNull();
    expect(out.bytesProcessed).toBe(1000);
    expect(out.records.map(r => r.layer)).toEqual(['l1', 'l2', 'l3']);
  });

  it('blocks at L1 and records only L1, never calling the dry run', async () => {
    mockStatic.mockReturnValue({ valid: false, layer: 'L1-static', error: 'DML blocked' });
    const out = await runCoreValidation('DELETE FROM t', 0);
    expect(out.blockedLayer).toBe('l1');
    expect(out.blocked?.error).toBe('DML blocked');
    expect(out.records.map(r => r.layer)).toEqual(['l1']);
    expect(mockDryRun).not.toHaveBeenCalled();
  });

  it('treats L2 as advisory: an invalid AST is recorded but does not block', async () => {
    mockAst.mockReturnValue({ valid: false, layer: 'L2-ast', error: 'parse error' });
    const out = await runCoreValidation('SELECT 1', 0);
    expect(out.blockedLayer).toBeNull();
    expect(out.records.map(r => r.layer)).toEqual(['l1', 'l2', 'l3']);
    expect(out.records[1].valid).toBe(false);
  });

  it('blocks at L3 and stamps the supplied attempt number on every record', async () => {
    mockDryRun.mockResolvedValue({ valid: false, layer: 'L3-dryrun', error: 'unknown column' });
    const out = await runCoreValidation('SELECT bad FROM t', 1);
    expect(out.blockedLayer).toBe('l3');
    expect(out.blocked?.error).toBe('unknown column');
    expect(out.records.map(r => r.layer)).toEqual(['l1', 'l2', 'l3']);
    expect(out.records.every(r => r.attempt === 1)).toBe(true);
  });
});
