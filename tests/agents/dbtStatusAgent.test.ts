import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent: mockGenerateContent } };
  }),
}));

import { handleDbtStatus } from '../../src/agents/dbtStatusAgent.js';
import type { DbtRunHistoryEntry } from '../../src/state/dbtRunHistory.js';

const sampleHistory: DbtRunHistoryEntry[] = [
  {
    model: 'dim_customers',
    status: 'success',
    executionTime: 12.5,
    runId: 'run-abc-123',
    runStartedAt: new Date('2026-02-14T10:00:00Z'),
  },
  {
    model: 'dim_customers',
    status: 'error',
    executionTime: 3.1,
    runId: 'run-abc-122',
    runStartedAt: new Date('2026-02-13T10:00:00Z'),
    errorMessage: 'Compilation error in model dim_customers',
  },
];

describe('handleDbtStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats run history into a conversational answer', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'The dim_customers model last ran successfully on Feb 14 at 10:00 AM UTC, taking 12.5 seconds. The previous run on Feb 13 failed with a compilation error.',
    });

    const result = await handleDbtStatus(
      'How is the dim_customers model doing?',
      sampleHistory,
      'test-api-key',
    );

    expect(result).toContain('dim_customers');
    expect(result).toContain('12.5 seconds');

    // Verify generateContent was called with the history data
    expect(mockGenerateContent).toHaveBeenCalledOnce();
    const callArgs = mockGenerateContent.mock.calls[0][0];
    const contents = callArgs.contents;
    expect(contents).toContain('dim_customers');
    expect(contents).toContain('How is the dim_customers model doing?');
  });

  it('returns hardcoded message when runHistory is empty (no LLM call)', async () => {
    const result = await handleDbtStatus(
      'What is the status of stg_orders?',
      [],
      'test-api-key',
    );

    expect(result).toBe(
      "I don't have any build history for that model. Make sure dbt run results are being sent to Anna Lytics.",
    );
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('uses the configured Flash model default', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'All models are running fine.',
    });

    await handleDbtStatus('Any issues?', sampleHistory, 'test-api-key');

    const callArgs = mockGenerateContent.mock.calls[0][0];
    expect(callArgs.model).toBe('gemini-flash-latest');
  });
});
