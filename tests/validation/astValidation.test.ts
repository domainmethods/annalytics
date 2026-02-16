import { describe, it, expect } from 'vitest';
import { astValidation } from '../../src/validation/astValidation.js';

describe('astValidation', () => {
  it('passes a valid SELECT statement', () => {
    const result = astValidation('SELECT id, name FROM users WHERE id = 1');
    expect(result.valid).toBe(true);
  });

  it('blocks DML detected in AST (INSERT)', () => {
    const result = astValidation('INSERT INTO users (name) VALUES ("test")');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Only SELECT');
  });

  it('blocks DDL detected in AST (CREATE TABLE)', () => {
    const result = astValidation('CREATE TABLE users (id INT64)');
    expect(result.valid).toBe(false);
  });

  it('returns advisory pass on parse failure for valid BigQuery syntax', () => {
    // QUALIFY is valid BigQuery but node-sql-parser may not support it
    const result = astValidation(
      'SELECT id, ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY created_at) AS rn FROM t QUALIFY rn = 1'
    );
    // Should not block — advisory mode on parse failure
    expect(result.valid).toBe(true);
    // But should note it was advisory
    if (result.error) {
      expect(result.error).toContain('advisory');
    }
  });

  it('passes SELECT with common BigQuery functions', () => {
    const result = astValidation(
      'SELECT DATE_TRUNC(order_date, MONTH) AS month, SUM(total_amount) AS revenue FROM analytics.fct_orders GROUP BY 1'
    );
    expect(result.valid).toBe(true);
  });

  it('passes SELECT with subquery', () => {
    const result = astValidation(
      'SELECT * FROM (SELECT id, name FROM users WHERE active = true) sub WHERE sub.id > 10'
    );
    expect(result.valid).toBe(true);
  });
});
