import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
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
});
