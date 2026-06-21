import { describe, expect, it } from 'vitest';
import {
  renderWhatsAppQueryAnswer,
  renderWhatsAppClarification,
  renderWhatsAppUnsupported,
  renderWhatsAppSafeError,
} from '../../src/whatsapp/renderer.js';

describe('WhatsApp renderer', () => {
  it('renders a compact single-value answer with trace id', () => {
    const text = renderWhatsAppQueryAnswer({
      explanation: 'Revenue was $12,345 yesterday.',
      rows: [{ revenue: 12345 }],
      columnNames: ['revenue'],
      totalRows: 1,
      assumptions: ['Timezone: UTC'],
      traceId: 'trace-1',
    });

    expect(text).toContain('Revenue was $12,345 yesterday.');
    expect(text).toContain('revenue: 12345');
    expect(text).toContain('Assumptions:');
    expect(text).toContain('- Timezone: UTC');
    expect(text).toContain('trace: trace-1');
  });

  it('renders and truncates table answers', () => {
    const text = renderWhatsAppQueryAnswer({
      explanation: 'Top rows.',
      rows: Array.from({ length: 8 }, (_, i) => ({ source: `source-${i}`, sessions: i })),
      columnNames: ['source', 'sessions'],
      totalRows: 8,
      assumptions: [],
      traceId: 'trace-2',
    });

    expect(text).toContain('source | sessions');
    expect(text).toContain('source-4 | 4');
    expect(text).toContain('Showing 5 of 8 rows.');
    expect(text).not.toContain('source-5 | 5');
  });

  it('sanitizes multiline cells and caps truncated cell width', () => {
    const longCell = 'x'.repeat(80);
    const text = renderWhatsAppQueryAnswer({
      explanation: 'Top rows.',
      rows: [{ source: 'email\npaid', campaign: longCell }],
      columnNames: ['source', 'campaign'],
      totalRows: 1,
      assumptions: [],
      traceId: 'trace-3',
    });

    expect(text).toContain('email paid');
    expect(text).toContain(`${'x'.repeat(57)}...`);
    expect(text).not.toContain('email\npaid');
  });

  it('transliterates common currency and math symbols to ASCII', () => {
    const text = renderWhatsAppQueryAnswer({
      explanation: 'Spend was €1,234, refunds were £99, and the threshold was ≥ 10.',
      rows: [],
      columnNames: ['metric'],
      totalRows: 0,
      assumptions: [],
      traceId: 'trace-symbols',
    });

    expect(text).toContain('Spend was EUR 1,234, refunds were GBP 99, and the threshold was >= 10.');
    expect(text).not.toMatch(/[€£≥]/);
  });

  it('preserves the trace footer when long messages are truncated', () => {
    const text = renderWhatsAppQueryAnswer({
      explanation: 'A'.repeat(4000),
      rows: [],
      columnNames: [],
      totalRows: 0,
      assumptions: [],
      traceId: 'trace-long',
    });

    expect(text.length).toBeLessThanOrEqual(3500);
    expect(text).toContain('[truncated]');
    expect(text).toContain('(trace: trace-long)');
  });

  it('sanitizes pipes inside table cells', () => {
    const text = renderWhatsAppQueryAnswer({
      explanation: 'Top rows.',
      rows: [{ source: 'email|paid', sessions: 10 }],
      columnNames: ['source', 'sessions'],
      totalRows: 1,
      assumptions: [],
      traceId: 'trace-pipe',
    });

    expect(text).toContain('email / paid | 10');
    expect(text).not.toContain('email|paid');
  });

  it('renders clarification text', () => {
    expect(renderWhatsAppClarification(['Which date range should I use?'], 'trace-3'))
      .toBe('I need one clarification before I query the warehouse:\n1. Which date range should I use?\n\nReply here with the answer. (trace: trace-3)');
  });

  it('renders unsupported and safe error text', () => {
    expect(renderWhatsAppUnsupported()).toBe('I can only answer text questions in this WhatsApp prototype.');
    expect(renderWhatsAppSafeError('trace-4')).toBe("I couldn't complete that request safely. Please try again or ask in Slack. (trace: trace-4)");
  });
});
