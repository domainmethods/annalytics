import { describe, it, expect } from 'vitest';
import { friendlyErrorMessage } from '../src/errors.js';

describe('friendlyErrorMessage', () => {
  const traceId = 'test-trace-123';

  it('maps NOT_FOUND to table-not-found message', () => {
    const error = new Error('NOT_FOUND: Table my_project.analytics.missing not found');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain("couldn't find one of the tables");
    expect(msg).not.toContain('NOT_FOUND');
  });

  it('maps ACCESS_DENIED to access message', () => {
    const error = new Error('ACCESS_DENIED: Permission denied');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain("don't have access");
  });

  it('maps FORBIDDEN to access message', () => {
    const error = new Error('FORBIDDEN: Insufficient permissions');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain("don't have access");
  });

  it('maps DEADLINE_EXCEEDED to timeout message', () => {
    const error = new Error('DEADLINE_EXCEEDED: Query timed out');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain('took too long');
  });

  it('maps timeout to timeout message', () => {
    const error = new Error('timeout after 30000ms');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain('took too long');
  });

  it('maps RESOURCE_EXHAUSTED to high-demand message', () => {
    const error = new Error('RESOURCE_EXHAUSTED: Quota exceeded');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain('high demand');
  });

  it('maps SAFETY to rephrase message', () => {
    const error = new Error('SAFETY: Content blocked');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain('rephrasing');
  });

  it('returns generic message with traceId for unknown errors', () => {
    const error = new Error('Something completely unexpected');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).toContain('Something went wrong');
    expect(msg).toContain(traceId);
  });

  it('never exposes raw error message to user', () => {
    const error = new Error('RESOURCE_EXHAUSTED: Quota exceeded for aiplatform.googleapis.com');
    const msg = friendlyErrorMessage(error, traceId);
    expect(msg).not.toContain('aiplatform.googleapis.com');
    expect(msg).not.toContain('Quota exceeded');
  });
});
