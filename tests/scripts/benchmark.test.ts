import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { referenceRetrievalPassed } from '../../scripts/benchmarkSupport.js';
import type { CorpusEntry } from '../../scripts/benchmark-types.js';

describe('benchmark corpus', () => {
  it('loads and validates corpus.json schema', () => {
    const raw = readFileSync('benchmarks/corpus.json', 'utf-8');
    const corpus: CorpusEntry[] = JSON.parse(raw);

    expect(corpus.length).toBeGreaterThan(0);
    for (const entry of corpus) {
      expect(entry.id).toBeTruthy();
      expect(entry.question).toBeTruthy();
      expect(['simple', 'join', 'aggregate', 'time_series', 'ambiguous', 'edge_case']).toContain(entry.category);
      expect(['manual', 'production_positive', 'production_negative', 'escalation']).toContain(entry.source);
    }
  });

  it('has unique IDs', () => {
    const raw = readFileSync('benchmarks/corpus.json', 'utf-8');
    const corpus: CorpusEntry[] = JSON.parse(raw);
    const ids = corpus.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('contains revenue reference-card benchmark cases', () => {
    const raw = readFileSync('benchmarks/corpus.json', 'utf-8');
    const corpus: CorpusEntry[] = JSON.parse(raw);
    const revenueCases = corpus.filter(entry => entry.expectedReferenceIds?.length);

    expect(revenueCases.length).toBeGreaterThanOrEqual(4);
    expect(revenueCases.map(entry => entry.id)).toContain('revenue-ref-001');
    expect(revenueCases.flatMap(entry => entry.expectedReferenceIds ?? [])).toContain(
      'revenue-canonical-definition',
    );
  });

  it('deterministically checks reference retrieval expectations for the revenue seed case', () => {
    const raw = readFileSync('benchmarks/corpus.json', 'utf-8');
    const corpus: CorpusEntry[] = JSON.parse(raw);
    const entry = corpus.find(item => item.id === 'revenue-ref-001');

    expect(entry?.expectedReferenceIds).toEqual(['revenue-canonical-definition']);
    expect(referenceRetrievalPassed(
      entry?.expectedReferenceIds,
      ['revenue-canonical-definition'],
    )).toBe(true);
    expect(referenceRetrievalPassed(
      entry?.expectedReferenceIds,
      [],
    )).toBe(false);
  });

  it('contains deterministic SQL-shape and clarification expectations for revenue cases', () => {
    const raw = readFileSync('benchmarks/corpus.json', 'utf-8');
    const corpus: CorpusEntry[] = JSON.parse(raw);
    const monthly = corpus.find(item => item.id === 'revenue-ref-002');
    const ambiguous = corpus.find(item => item.id === 'revenue-ref-005');

    expect(monthly?.expectedTables).toEqual(['analytics.fct_orders']);
    expect(monthly?.expectedSqlContains).toContain('DATE_TRUNC');
    expect(ambiguous?.expectedReferenceIds).toBeUndefined();
    expect(ambiguous?.expectedClarificationConfidence).toBe('low');
  });
});
