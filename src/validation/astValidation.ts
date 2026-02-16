import { Parser } from 'node-sql-parser';
import type { ValidationResult } from '../types.js';

const parser = new Parser();

export function astValidation(sql: string): ValidationResult {
  try {
    const ast = parser.astify(sql, { database: 'BigQuery' });
    const statements = Array.isArray(ast) ? ast : [ast];

    for (const stmt of statements) {
      if (stmt.type !== 'select') {
        return {
          valid: false,
          layer: 'L2-ast',
          error: `Only SELECT statements are allowed (found: ${stmt.type?.toUpperCase()})`,
        };
      }
    }

    return { valid: true, layer: 'L2-ast' };
  } catch {
    return {
      valid: true,
      layer: 'L2-ast',
      error: 'L2 advisory: AST parse failed — deferring to BigQuery dry run for validation',
    };
  }
}
