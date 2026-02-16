import type { ValidationResult } from '../types.js';

// DML/DDL keywords that must appear as standalone statements (not substrings)
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Compound statements first (contain other DML keywords in their syntax)
  { pattern: /\b(MERGE)\b/i, label: 'MERGE' },
  { pattern: /\b(LOAD)\s+DATA\b/i, label: 'LOAD DATA' },
  // DDL
  { pattern: /\b(DROP)\b/i, label: 'DROP' },
  { pattern: /\b(ALTER)\b/i, label: 'ALTER' },
  { pattern: /\b(CREATE)\b/i, label: 'CREATE' },
  { pattern: /\b(TRUNCATE)\b/i, label: 'TRUNCATE' },
  // DML
  { pattern: /\b(DELETE)\b/i, label: 'DELETE' },
  { pattern: /\b(INSERT)\b/i, label: 'INSERT' },
  { pattern: /\b(UPDATE)\b/i, label: 'UPDATE' },
  // Permissions / execution
  { pattern: /\b(GRANT)\s+/i, label: 'GRANT' },
  { pattern: /\b(REVOKE)\s+/i, label: 'REVOKE' },
  { pattern: /\b(CALL)\b/i, label: 'CALL' },
  { pattern: /\b(EXECUTE)\b/i, label: 'EXECUTE' },
];

export function staticAnalysis(sql: string): ValidationResult {
  // Strip string literals and backtick-quoted identifiers before checking
  // Prevents false positives from quoted content (e.g., `drop` as a column name)
  const stripped = sql
    .replace(/'(?:[^'\\]|\\.)*'/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '')
    .replace(/`(?:[^`\\]|\\.)*`/g, '');

  // Check for multi-statement queries
  const statements = stripped.split(';').filter((s) => s.trim().length > 0);
  if (statements.length > 1) {
    return { valid: false, layer: 'L1-static', error: 'Blocked: multi-statement query detected' };
  }

  // Check for SQL comments
  if (/--/.test(stripped)) {
    return { valid: false, layer: 'L1-static', error: 'Blocked: SQL comment (--) detected' };
  }
  if (/\/\*/.test(stripped)) {
    return { valid: false, layer: 'L1-static', error: 'Blocked: SQL comment (/* */) detected' };
  }

  // Check for DML/DDL keywords on the stripped SQL
  for (const { pattern, label } of BLOCKED_PATTERNS) {
    if (pattern.test(stripped)) {
      return { valid: false, layer: 'L1-static', error: `Blocked: ${label} statement detected` };
    }
  }

  return { valid: true, layer: 'L1-static' };
}
