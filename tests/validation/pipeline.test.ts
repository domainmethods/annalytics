import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateSql } from '../../src/validation/pipeline.js';
import { staticAnalysis } from '../../src/validation/staticAnalysis.js';
import { astValidation } from '../../src/validation/astValidation.js';
import { dryRunValidation } from '../../src/validation/dryRun.js';
import { costGate } from '../../src/validation/costGate.js';

vi.mock('../../src/validation/staticAnalysis.js');
vi.mock('../../src/validation/astValidation.js');
vi.mock('../../src/validation/dryRun.js');
vi.mock('../../src/validation/costGate.js');

describe('validateSql', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns valid when all layers pass', async () => {
    vi.mocked(staticAnalysis).mockReturnValue({ valid: true, layer: 'L1-static' });
    vi.mocked(astValidation).mockReturnValue({ valid: true, layer: 'L2-ast' });
    vi.mocked(dryRunValidation).mockResolvedValue({ valid: true, layer: 'L3-dryrun', bytesProcessed: 100 });
    vi.mocked(costGate).mockReturnValue({ valid: true, layer: 'L4-cost', bytesProcessed: 100 });

    const result = await validateSql('SELECT *', 1000);
    expect(result).toEqual({ valid: true, layer: 'all', bytesProcessed: 100 });
    expect(staticAnalysis).toHaveBeenCalled();
    expect(astValidation).toHaveBeenCalled();
    expect(dryRunValidation).toHaveBeenCalled();
    expect(costGate).toHaveBeenCalledWith(100, 1000);
  });

  it('short-circuits on L1 failure', async () => {
    vi.mocked(staticAnalysis).mockReturnValue({ valid: false, layer: 'L1-static', error: 'L1 failed' });

    const result = await validateSql('SELECT *', 1000);
    expect(result).toEqual({ valid: false, layer: 'L1-static', error: 'L1 failed' });
    expect(astValidation).not.toHaveBeenCalled();
    expect(dryRunValidation).not.toHaveBeenCalled();
  });

  it('L2 failure is advisory — continues to L3', async () => {
    vi.mocked(staticAnalysis).mockReturnValue({ valid: true, layer: 'L1-static' });
    vi.mocked(astValidation).mockReturnValue({ valid: false, layer: 'L2-ast', error: 'L2 failed' });
    vi.mocked(dryRunValidation).mockResolvedValue({ valid: true, layer: 'L3-dryrun', bytesProcessed: 100 });
    vi.mocked(costGate).mockReturnValue({ valid: true, layer: 'L4-cost', bytesProcessed: 100 });

    const result = await validateSql('SELECT *', 1000);
    expect(result).toEqual({ valid: true, layer: 'all', bytesProcessed: 100 });
    expect(dryRunValidation).toHaveBeenCalled();
  });

  it('passes dry run bytes to cost gate', async () => {
    vi.mocked(staticAnalysis).mockReturnValue({ valid: true, layer: 'L1-static' });
    vi.mocked(astValidation).mockReturnValue({ valid: true, layer: 'L2-ast' });
    vi.mocked(dryRunValidation).mockResolvedValue({ valid: true, layer: 'L3-dryrun', bytesProcessed: 500 });
    vi.mocked(costGate).mockReturnValue({ valid: true, layer: 'L4-cost', bytesProcessed: 500 });

    await validateSql('SELECT *', 1000);
    expect(costGate).toHaveBeenCalledWith(500, 1000);
  });

  it('skips cost gate on L3 failure', async () => {
    vi.mocked(staticAnalysis).mockReturnValue({ valid: true, layer: 'L1-static' });
    vi.mocked(astValidation).mockReturnValue({ valid: true, layer: 'L2-ast' });
    vi.mocked(dryRunValidation).mockResolvedValue({ valid: false, layer: 'L3-dryrun', error: 'L3 failed' });

    const result = await validateSql('SELECT *', 1000);
    expect(result).toEqual({ valid: false, layer: 'L3-dryrun', error: 'L3 failed' });
    expect(costGate).not.toHaveBeenCalled();
  });
});
