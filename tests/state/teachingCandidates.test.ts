import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveTeachingCandidate,
  getPendingCandidates,
  updateCandidateStatus,
} from '../../src/state/teachingCandidates.js';
import type { TeachingCandidate } from '../../src/state/teachingCandidates.js';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockDoc = vi.fn(() => ({ set: mockSet, get: mockGet, update: mockUpdate }));
const mockCollection = vi.fn(() => ({
  doc: mockDoc,
  where: mockWhere,
  orderBy: mockOrderBy,
}));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({
    collection: mockCollection,
  })),
}));

function makeCandidate(overrides: Partial<TeachingCandidate> = {}): TeachingCandidate {
  return {
    candidateId: 'cand-001',
    escalationId: 'esc-123',
    status: 'pending',
    questionPatterns: ['revenue by region', 'regional revenue breakdown'],
    reasoning: 'Common pattern for regional revenue analysis',
    sanctionedSql: 'SELECT region, SUM(revenue) FROM sales GROUP BY region',
    modelsReferenced: ['sales', 'regions'],
    tags: ['revenue', 'regional'],
    originalQuestion: 'What is revenue by region?',
    humanResponse: 'Use the sales table joined with regions',
    generatedAt: new Date('2026-02-15T10:00:00Z'),
    ...overrides,
  };
}

describe('saveTeachingCandidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
  });

  it('saves a candidate to Firestore with all fields', async () => {
    const candidate = makeCandidate();

    await saveTeachingCandidate(candidate);

    expect(mockCollection).toHaveBeenCalledWith('teaching_candidates');
    expect(mockDoc).toHaveBeenCalledWith('cand-001');
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: 'cand-001',
        escalationId: 'esc-123',
        status: 'pending',
        questionPatterns: ['revenue by region', 'regional revenue breakdown'],
        reasoning: 'Common pattern for regional revenue analysis',
        sanctionedSql: 'SELECT region, SUM(revenue) FROM sales GROUP BY region',
        modelsReferenced: ['sales', 'regions'],
        tags: ['revenue', 'regional'],
        originalQuestion: 'What is revenue by region?',
        humanResponse: 'Use the sales table joined with regions',
        generatedAt: expect.any(Date),
      }),
    );
  });
});

describe('getPendingCandidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns only pending candidates ordered by generatedAt DESC', async () => {
    const date1 = new Date('2026-02-15T10:00:00Z');
    const date2 = new Date('2026-02-15T11:00:00Z');

    // where returns object with orderBy, orderBy returns object with get
    mockWhere.mockReturnValue({
      orderBy: mockOrderBy,
    });
    mockOrderBy.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        empty: false,
        docs: [
          {
            data: () => ({
              candidateId: 'cand-002',
              escalationId: 'esc-456',
              status: 'pending',
              questionPatterns: ['q2'],
              reasoning: 'r2',
              sanctionedSql: null,
              modelsReferenced: ['m2'],
              tags: ['t2'],
              originalQuestion: 'Question 2?',
              humanResponse: 'Response 2',
              generatedAt: { toDate: () => date2 },
            }),
          },
          {
            data: () => ({
              candidateId: 'cand-001',
              escalationId: 'esc-123',
              status: 'pending',
              questionPatterns: ['q1'],
              reasoning: 'r1',
              sanctionedSql: 'SELECT 1',
              modelsReferenced: ['m1'],
              tags: ['t1'],
              originalQuestion: 'Question 1?',
              humanResponse: 'Response 1',
              generatedAt: { toDate: () => date1 },
            }),
          },
        ],
      }),
    });

    const results = await getPendingCandidates();

    expect(mockCollection).toHaveBeenCalledWith('teaching_candidates');
    expect(mockWhere).toHaveBeenCalledWith('status', '==', 'pending');
    expect(mockOrderBy).toHaveBeenCalledWith('generatedAt', 'desc');
    expect(results).toHaveLength(2);
    expect(results[0].candidateId).toBe('cand-002');
    expect(results[1].candidateId).toBe('cand-001');
    // Verify Firestore timestamps converted to Date
    expect(results[0].generatedAt).toBeInstanceOf(Date);
    expect(results[0].generatedAt.getTime()).toBe(date2.getTime());
    expect(results[1].generatedAt).toBeInstanceOf(Date);
    expect(results[1].generatedAt.getTime()).toBe(date1.getTime());
  });

  it('returns empty array when no pending candidates exist', async () => {
    mockWhere.mockReturnValue({
      orderBy: mockOrderBy,
    });
    mockOrderBy.mockReturnValue({
      get: vi.fn().mockResolvedValue({
        empty: true,
        docs: [],
      }),
    });

    const results = await getPendingCandidates();

    expect(results).toEqual([]);
  });
});

describe('updateCandidateStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue(undefined);
  });

  it('updates the status field of a candidate document', async () => {
    await updateCandidateStatus('cand-001', 'approved');

    expect(mockCollection).toHaveBeenCalledWith('teaching_candidates');
    expect(mockDoc).toHaveBeenCalledWith('cand-001');
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'approved' });
  });

  it('supports rejected status', async () => {
    await updateCandidateStatus('cand-002', 'rejected');

    expect(mockDoc).toHaveBeenCalledWith('cand-002');
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'rejected' });
  });
});
