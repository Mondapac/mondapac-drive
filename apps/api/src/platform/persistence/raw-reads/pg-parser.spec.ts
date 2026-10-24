import { parseSql } from './pg-parser';

// Loader smoke test (ADR-0030, Ali's ruling C-g): the pinned parser loads, speaks the
// PostgreSQL major the project runs (17), refuses bad text and yields one entry per statement.
describe('parseSql (libpg-query)', () => {
  it('parses a SELECT with the PostgreSQL 17 grammar', async () => {
    const tree = (await parseSql('SELECT 1')) as { version: number; stmts: unknown[] };

    expect(tree.version).toBe(170007);
    expect(tree.stmts).toHaveLength(1);
  });

  it('rejects a syntax error', async () => {
    await expect(parseSql('SELEC 1')).rejects.toThrow();
  });

  it('yields more than one statement for a multi-statement text', async () => {
    const tree = (await parseSql('SELECT 1; SELECT 2')) as { stmts: unknown[] };

    expect(tree.stmts.length).toBeGreaterThan(1);
  });
});
