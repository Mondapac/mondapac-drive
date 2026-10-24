import { Client } from 'pg';
import { lockingOwnerTestDatabaseUrl, lockingTestDatabaseUrl } from './test-database';

// docs/design/data/sellers.md 9.2: btree_gist lives in schema "extensions", which the
// application role cannot use, and still works for it through an exclusion constraint.
// The probe table lives in the locking copy of the run database, so the privilege test of the
// main database never sees it.

describe('btree_gist for the application role (sellers data design 9.2)', () => {
  let owner: Client;
  let app: Client;

  beforeAll(async () => {
    owner = new Client({ connectionString: lockingOwnerTestDatabaseUrl() });
    await owner.connect();
    await owner.query(`CREATE SCHEMA btree_gist_probe`);
    await owner.query(`
      CREATE TABLE btree_gist_probe.periods (
        market_id text NOT NULL,
        seller_id uuid NOT NULL,
        valid_from date NOT NULL,
        valid_to date,
        CONSTRAINT periods_no_overlap EXCLUDE USING gist (
          market_id WITH =, seller_id WITH =,
          daterange(valid_from, valid_to) WITH &&
        )
      )`);
    await owner.query(`GRANT USAGE ON SCHEMA btree_gist_probe TO drive_app`);
    await owner.query(`GRANT SELECT, INSERT ON btree_gist_probe.periods TO drive_app`);
    await owner.query(`GRANT UPDATE (valid_to) ON btree_gist_probe.periods TO drive_app`);
    app = new Client({ connectionString: lockingTestDatabaseUrl() });
    await app.connect();
  });

  afterAll(async () => {
    await app.end();
    await owner.query(`DROP SCHEMA btree_gist_probe CASCADE`);
    await owner.end();
  });

  const seller = '00000000-0000-4000-8000-000000000001';

  it('has no USAGE on the schema and no search_path entry for it', async () => {
    const usage = await app.query(`SELECT has_schema_privilege('extensions', 'USAGE') AS usage`);
    const path = await app.query<{ path: string }>(`SELECT current_setting('search_path') AS path`);

    expect(usage.rows[0]).toEqual({ usage: false });
    expect(path.rows[0]?.path).not.toContain('extensions');
  });

  it('refuses a direct call of an extension function (42501)', async () => {
    await expect(app.query(`SELECT extensions.int4_dist(1, 2)`)).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('inserts, refuses an overlap (23P01) and closes a period under UPDATE (valid_to)', async () => {
    await app.query(`INSERT INTO btree_gist_probe.periods VALUES ('AU', $1, '2026-01-01', NULL)`, [
      seller,
    ]);
    await expect(
      app.query(`INSERT INTO btree_gist_probe.periods VALUES ('AU', $1, '2026-06-01', NULL)`, [
        seller,
      ]),
    ).rejects.toMatchObject({ code: '23P01' });
    await app.query(
      `UPDATE btree_gist_probe.periods SET valid_to = '2026-03-01' WHERE seller_id = $1`,
      [seller],
    );
    // Now closed: a later period for the same seller fits, another Market's never collided.
    await app.query(`INSERT INTO btree_gist_probe.periods VALUES ('AU', $1, '2026-03-01', NULL)`, [
      seller,
    ]);
    await app.query(`INSERT INTO btree_gist_probe.periods VALUES ('ZZ', $1, '2026-01-01', NULL)`, [
      seller,
    ]);
    const asOf = await app.query(
      `SELECT valid_from::text FROM btree_gist_probe.periods
        WHERE market_id = 'AU' AND seller_id = $1 AND daterange(valid_from, valid_to) @> '2026-02-01'::date`,
      [seller],
    );
    expect(asOf.rows).toEqual([{ valid_from: '2026-01-01' }]);
  });

  it('refuses an UPDATE of another column (42501)', async () => {
    await expect(
      app.query(`UPDATE btree_gist_probe.periods SET valid_from = '2025-01-01'`),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
