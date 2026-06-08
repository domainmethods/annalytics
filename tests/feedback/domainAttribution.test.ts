import { describe, it, expect } from 'vitest';
import { resolveDomain, tableFallbackTag, type DomainMapEntry } from '../../src/feedback/domainAttribution.js';

const map: DomainMapEntry[] = [{ table: 'analytics.fct_orders', domain: 'revenue' }];

describe('resolveDomain', () => {
  it('attributes by cited card table first', () => {
    expect(resolveDomain(['analytics.fct_orders'], map)).toBe('revenue');
  });
  it('falls back to the dataset tag when no card matches', () => {
    expect(resolveDomain(['analytics.dim_users'], map)).toBe('analytics');
  });
  it('returns unclassified when no tables were used', () => {
    expect(resolveDomain([], map)).toBe('unclassified');
  });
  it('prefers a card hit even when it is not the first table', () => {
    expect(resolveDomain(['analytics.dim_users', 'analytics.fct_orders'], map)).toBe('revenue');
  });
  it('normalizes backticks and casing in untrusted LLM table names', () => {
    expect(resolveDomain(['`analytics.fct_orders`'], map)).toBe('revenue');
    expect(resolveDomain(['Analytics.FCT_Orders'], map)).toBe('revenue');
  });
});

describe('tableFallbackTag', () => {
  it('uses the dataset segment of a qualified table', () => {
    expect(tableFallbackTag('analytics.fct_orders')).toBe('analytics');
    expect(tableFallbackTag('proj.analytics.fct_orders')).toBe('analytics');
  });
});
