import { GoogleGenAI } from '@google/genai';
import { expect, it, vi } from 'vitest';
import { generateForNode } from '../../src/agents/modelGateway.js';
import { summarizeResults } from '../../src/agents/summaryAgent.js';

vi.mock('@google/genai', () => ({ GoogleGenAI: vi.fn(class { models = {}; }) }));
vi.mock('../../src/agents/modelGateway.js', () => ({ generateForNode: vi.fn() }));

const input = {
  question: 'What is revenue?',
  sql: 'SELECT 42 AS revenue',
  rows: [{ revenue: 42 }],
  totalRows: 1,
  apiKey: 'test-key',
};

it('sends the same prompt as the Slack override and returns the response text', async () => {
  vi.mocked(generateForNode).mockResolvedValueOnce({
    get text() { return 'Revenue was $42.'; },
  } as Awaited<ReturnType<typeof generateForNode>>);

  await expect(summarizeResults(input)).resolves.toBe('Revenue was $42.');
  expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: 'test-key' });
  expect(generateForNode).toHaveBeenCalledWith('summaryOverride', expect.any(GoogleGenAI), {
    contents: [{
      role: 'user',
      parts: [{
        text: 'Summarize these query results in 2-3 sentences for a business user.\n\nQuestion: What is revenue?\nSQL: SELECT 42 AS revenue\n\nResults (1 total rows, showing first 1):\n[\n  {\n    "revenue": 42\n  }\n]',
      }],
    }],
  });
});

it('returns an empty string when generation fails', async () => {
  vi.mocked(generateForNode).mockRejectedValueOnce(new Error('generation failed'));
  await expect(summarizeResults(input)).resolves.toBe('');
});
