import { describe, it, expect } from 'vitest';
import { staticAnalysis } from '../../src/validation/staticAnalysis.js';

describe('staticAnalysis', () => {
  it('passes a valid SELECT statement', () => {
    const result = staticAnalysis('SELECT id, name FROM users WHERE id = 1');
    expect(result.valid).toBe(true);
  });

  it('blocks DROP statements', () => {
    const result = staticAnalysis('DROP TABLE users');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('DROP');
  });

  it('blocks ALTER statements', () => {
    const result = staticAnalysis('ALTER TABLE users ADD COLUMN age INT');
    expect(result.valid).toBe(false);
  });

  it('blocks DELETE statements', () => {
    const result = staticAnalysis('DELETE FROM users WHERE id = 1');
    expect(result.valid).toBe(false);
  });

  it('blocks INSERT statements', () => {
    const result = staticAnalysis('INSERT INTO users (name) VALUES ("test")');
    expect(result.valid).toBe(false);
  });

  it('blocks UPDATE statements', () => {
    const result = staticAnalysis('UPDATE users SET name = "test" WHERE id = 1');
    expect(result.valid).toBe(false);
  });

  it('blocks CREATE statements', () => {
    const result = staticAnalysis('CREATE TABLE users (id INT)');
    expect(result.valid).toBe(false);
  });

  it('blocks GRANT statements', () => {
    const result = staticAnalysis('GRANT SELECT ON users TO user1');
    expect(result.valid).toBe(false);
  });

  it('blocks REVOKE statements', () => {
    const result = staticAnalysis('REVOKE SELECT ON users FROM user1');
    expect(result.valid).toBe(false);
  });

  it('blocks TRUNCATE statements', () => {
    const result = staticAnalysis('TRUNCATE TABLE users');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('TRUNCATE');
  });

  it('blocks MERGE statements', () => {
    const result = staticAnalysis('MERGE INTO target USING source ON target.id = source.id WHEN MATCHED THEN DELETE');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('MERGE');
  });

  it('blocks multi-statement queries (semicolon-separated)', () => {
    const result = staticAnalysis('SELECT 1; DROP TABLE users');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('multi-statement');
  });

  it('blocks SQL comments (-- style)', () => {
    const result = staticAnalysis('SELECT 1 -- this is fine');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('comment');
  });

  it('blocks SQL comments (/* */ style)', () => {
    const result = staticAnalysis('SELECT /* comment */ 1');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('comment');
  });

  it('is case-insensitive', () => {
    const result = staticAnalysis('drop TABLE users');
    expect(result.valid).toBe(false);
  });

  it('does not false-positive on column names containing keywords', () => {
    const result = staticAnalysis('SELECT updated_at, created_at, drop_date FROM orders');
    expect(result.valid).toBe(true);
  });

  it('does not false-positive on backtick-quoted identifiers', () => {
    const result = staticAnalysis('SELECT `drop`, `update`, `group` FROM stats');
    expect(result.valid).toBe(true);
  });

  it('handles escaped quotes in string literals', () => {
    const result = staticAnalysis("SELECT name FROM users WHERE name = 'O\\'Reilly'");
    expect(result.valid).toBe(true);
  });

  it('blocks UPDATE with quoted table name', () => {
    const result = staticAnalysis('UPDATE "users" SET x = 1');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('UPDATE');
  });

  it('blocks CALL statements (stored procedures)', () => {
    const result = staticAnalysis('CALL my_dataset.my_procedure()');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('CALL');
  });

  it('blocks EXECUTE statements (dynamic SQL)', () => {
    const result = staticAnalysis('EXECUTE IMMEDIATE "SELECT 1"');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('EXECUTE');
  });

  it('blocks LOAD DATA statements', () => {
    const result = staticAnalysis('LOAD DATA INTO my_table FROM FILES(uris=["gs://bucket/file.csv"])');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('LOAD DATA');
  });

  // Bypass prevention: BigQuery allows DML without FROM/INTO keywords
  it('blocks DELETE without FROM (BigQuery syntax)', () => {
    const result = staticAnalysis('DELETE my_table WHERE true');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('DELETE');
  });

  it('blocks INSERT without INTO (BigQuery syntax)', () => {
    const result = staticAnalysis('INSERT my_table (col) VALUES (1)');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('INSERT');
  });

  it('blocks CREATE MODEL (not just TABLE/VIEW)', () => {
    const result = staticAnalysis('CREATE MODEL my_dataset.my_model OPTIONS(model_type="linear_reg")');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('CREATE');
  });

  it('passes SELECT with ML.FORECAST (BQML prediction)', () => {
    const result = staticAnalysis("SELECT * FROM ML.FORECAST(MODEL `project.dataset.model`, STRUCT(30 AS horizon))");
    expect(result.valid).toBe(true);
  });

  it('blocks CREATE OR REPLACE MODEL (BQML training DDL)', () => {
    const result = staticAnalysis("CREATE OR REPLACE MODEL `project.dataset.model` OPTIONS(model_type='ARIMA_PLUS') AS SELECT date, amount FROM revenue");
    expect(result.valid).toBe(false);
  });
});
