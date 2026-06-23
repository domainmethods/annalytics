import { describe, expect, it } from 'vitest';
import { buildWhatsAppActionId, parseWhatsAppActionId } from '../../src/whatsapp/actionIds.js';

describe('whatsapp action ids', () => {
  it('builds compact versioned action ids', () => {
    expect(buildWhatsAppActionId('show_sql', 'ctx_123')).toBe('wa:v1:show_sql:ctx_123');
  });

  it('parses valid ids', () => {
    expect(parseWhatsAppActionId('wa:v1:override_summary:ctx_456')).toEqual({
      kind: 'override_summary',
      contextId: 'ctx_456',
    });
  });

  it('rejects unknown action kinds', () => {
    expect(parseWhatsAppActionId('wa:v1:delete_everything:ctx_456')).toBeNull();
  });

  it('rejects malformed ids', () => {
    expect(parseWhatsAppActionId('show_sql:ctx_456')).toBeNull();
    expect(parseWhatsAppActionId('wa:v2:show_sql:ctx_456')).toBeNull();
    expect(parseWhatsAppActionId('wa:v1:show_sql:')).toBeNull();
  });

  it('rejects invalid action contexts when building ids', () => {
    expect(() => buildWhatsAppActionId('show_sql', '')).toThrow('Invalid WhatsApp action context id');
    expect(() => buildWhatsAppActionId('show_sql', 'ctx:456')).toThrow(
      'Invalid WhatsApp action context id',
    );
  });

  it('keeps parser behavior unchanged for malformed ids with embedded separators', () => {
    expect(parseWhatsAppActionId('wa:v1:show_sql:ctx:456')).toBeNull();
  });
});
