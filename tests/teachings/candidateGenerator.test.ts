import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateTeachingCandidate } from '../../src/teachings/candidateGenerator.js';
import type { EscalationTeachingContext } from '../../src/teachings/candidateGenerator.js';

const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return {
      models: { generateContent: mockGenerateContent },
    };
  }),
}));

function baseContext(overrides: Partial<EscalationTeachingContext> = {}): EscalationTeachingContext {
  return {
    escalationId: 'esc_abc123',
    originalQuestion: 'What is our monthly churn rate?',
    clarifiedQuestion: 'What percentage of customers had no orders in the last 90 days, broken down by month?',
    humanResponse: 'Use dim_customers with last_order_date field. Churn = no order in 90 days.',
    failedSql: 'SELECT * FROM analytics.orders',
    supervisorNotes: 'Confirmed churn definition matches business glossary.',
    apiKey: 'test-api-key',
    ...overrides,
  };
}

const validLLMResponse = {
  questionPatterns: [
    'churn rate',
    'monthly churn',
    'customer churn by month',
  ],
  reasoning: 'Churn is defined as customers with no orders in 90 days. Use dim_customers table and filter by last_order_date.',
  sanctionedSql: 'SELECT DATE_TRUNC(last_order_date, MONTH) AS month, COUNT(*) FROM analytics.dim_customers WHERE last_order_date < DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY) GROUP BY 1',
  modelsReferenced: ['analytics.dim_customers'],
  tags: ['churn', 'customers', 'retention'],
};

describe('generateTeachingCandidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates a valid TeachingCandidate from escalation context', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(validLLMResponse),
    });

    const candidate = await generateTeachingCandidate(baseContext());

    expect(candidate.candidateId).toBe('teach_esc_abc123');
    expect(candidate.escalationId).toBe('esc_abc123');
    expect(candidate.status).toBe('pending');
    expect(candidate.generatedAt).toBeInstanceOf(Date);
    expect(candidate.originalQuestion).toBe('What is our monthly churn rate?');
    expect(candidate.humanResponse).toBe('Use dim_customers with last_order_date field. Churn = no order in 90 days.');
    expect(candidate.questionPatterns).toEqual(validLLMResponse.questionPatterns);
    expect(candidate.reasoning).toBe(validLLMResponse.reasoning);
    expect(candidate.sanctionedSql).toBe(validLLMResponse.sanctionedSql);
    expect(candidate.modelsReferenced).toEqual(['analytics.dim_customers']);
    expect(candidate.tags).toEqual(['churn', 'customers', 'retention']);
  });

  it('labels prior SQL as failed SQL instead of sanctioned final SQL', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(validLLMResponse),
    });

    await generateTeachingCandidate(baseContext());

    const call = mockGenerateContent.mock.calls[0][0];
    const userContent = JSON.stringify(call.contents);
    expect(userContent).toContain('Failed SQL');
    expect(userContent).toContain('SELECT * FROM analytics.orders');
    expect(userContent).not.toContain('Final SQL');
  });

  it('handles context with missing failedSql and supervisorNotes', async () => {
    const responseWithoutSql = {
      ...validLLMResponse,
      sanctionedSql: null,
    };
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(responseWithoutSql),
    });

    const ctx = baseContext({ failedSql: undefined, supervisorNotes: undefined });
    const candidate = await generateTeachingCandidate(ctx);

    expect(candidate.sanctionedSql).toBeNull();
    expect(candidate.candidateId).toBe('teach_esc_abc123');
    expect(candidate.status).toBe('pending');

    // Verify the prompt content does NOT include failedSql or supervisorNotes sections
    const call = mockGenerateContent.mock.calls[0][0];
    const userContent = JSON.stringify(call.contents);
    expect(userContent).not.toContain('Failed SQL');
    expect(userContent).not.toContain('Supervisor Notes');
  });

  it('uses the configured Flash model default with structured output config', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(validLLMResponse),
    });

    await generateTeachingCandidate(baseContext());

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.model).toBe('gemini-3-flash-preview');
    expect(call.config.responseMimeType).toBe('application/json');
    expect(call.config.responseJsonSchema).toBeDefined();
    expect(call.config.systemInstruction).toContain('reusable teaching');
  });
});
