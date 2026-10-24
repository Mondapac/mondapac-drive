import { parseSql } from './pg-parser';
import { checkStatement, type StatementOwner } from './statement-check';

// The parse check of ADR-0030 decisions 3 to 5 with the real parser (Hassan I-1, Sajad's
// loader smoke test): what passes, and one case per rule it must refuse.

const owner: StatementOwner = {
  schema: 'delivery',
  tables: new Set(['deliveries', 'delivery_events', 'delivery_events']),
};

const GOOD = `
SELECT q.ord, t.id AS type_id, c.status, i.state
  FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS q(seller_id, type_code, ord)
  JOIN "delivery"."deliveries" t ON t.market_id = $1 AND t.code = q.type_code
  JOIN "delivery"."delivery_events" c
    ON c.market_id = $1 AND c.seller_id = q.seller_id AND c.type_id = t.id
   AND c.status NOT IN ('declined', 'revoked')
  LEFT JOIN "delivery"."delivery_events" i ON i.market_id = $1 AND i.type_id = t.id`;

const check = (sql: string, params: readonly unknown[] = [{}, {}]): Promise<string[]> =>
  checkStatement(parseSql, { id: 'delivery.test', sql, params }, owner);

describe('the parser loads and reads PostgreSQL 17', () => {
  it('answers PostgreSQL 17, rejects a syntax error and sees stacked statements', async () => {
    const parsed = await parseSql('select 1; select 2');
    expect((parsed as { version: number }).version).toBe(170007);
    expect(parsed.stmts).toHaveLength(2);
    await expect(parseSql('selec 1')).rejects.toThrow(/syntax error/);
  });
});

describe('raw read statement check', () => {
  it('passes a listed-style statement (unnest, joins, literals, own schema)', async () => {
    expect(await check(GOOD)).toEqual([]);
  });

  it('passes a root table with the Market in WHERE, a CTE and a set operation', async () => {
    expect(
      await check(
        `WITH w AS (SELECT t.id FROM "delivery"."deliveries" t WHERE t.market_id = $1)
         SELECT w.id FROM w
         UNION ALL
         SELECT i.id FROM "delivery"."delivery_events" i WHERE i.market_id = $1 AND i.type_id = ANY($2::uuid[])`,
        [{}],
      ),
    ).toEqual([]);
  });

  it.each([
    ['stacked statements', 'SELECT 1; SELECT 2', 'not-one-statement'],
    ['an insert', 'INSERT INTO "delivery"."delivery_events" (id) VALUES ($1)', 'not-a-select'],
    ['a syntax error', 'SELEC 1', 'parse-failed'],
  ])('refuses %s', async (_name, sql, violation) => {
    expect(await check(sql, [])).toEqual([violation]);
  });

  it('refuses a data-modifying CTE', async () => {
    const result = await check(
      `WITH d AS (DELETE FROM "delivery"."delivery_events" i WHERE i.market_id = $1 RETURNING i.id)
       SELECT d.id FROM d`,
      [],
    );
    expect(result).toEqual(expect.arrayContaining(['data-modifying-cte']));
  });

  it.each([
    ['FOR UPDATE', 'locking-clause', `${GOOD} FOR UPDATE OF t`],
    ['FOR SHARE', 'locking-clause', `${GOOD} FOR SHARE`],
    [
      'SELECT INTO',
      'select-into',
      `SELECT t.id INTO TEMP x FROM "delivery"."deliveries" t WHERE t.market_id = $1`,
    ],
  ])('refuses %s', async (_name, violation, sql) => {
    expect(await check(sql, [{}, {}])).toContain(violation);
  });

  it.each([
    [
      'another module schema',
      'relation-schema:sellers.seller_files',
      `SELECT 1 FROM "sellers"."seller_files" s WHERE s.market_id = $1`,
    ],
    ['public', 'relation-schema:public.x', `SELECT 1 FROM "public"."x" s WHERE s.market_id = $1`],
    [
      'a system catalog',
      'relation-schema:pg_catalog.pg_class',
      `SELECT 1 FROM pg_catalog.pg_class s WHERE s.market_id = $1`,
    ],
    [
      'an unqualified table',
      'relation-unqualified:issuers',
      `SELECT 1 FROM issuers s WHERE s.market_id = $1`,
    ],
    [
      'a table that is not an owner model (a view)',
      'relation-not-owner-table:v_delivery_events',
      `SELECT 1 FROM "delivery"."v_delivery_events" s WHERE s.market_id = $1`,
    ],
  ])('refuses %s', async (_name, violation, sql) => {
    expect(await check(sql, [])).toContain(violation);
  });

  it.each([
    [
      'now()',
      'function-not-allowed:now',
      `SELECT now() FROM "delivery"."delivery_events" i WHERE i.market_id = $1`,
    ],
    [
      'nextval',
      'function-not-allowed:nextval',
      `SELECT nextval('s') FROM "delivery"."delivery_events" i WHERE i.market_id = $1`,
    ],
    [
      'set_config',
      'function-not-allowed:set_config',
      `SELECT set_config('a','b',false) FROM "delivery"."delivery_events" i WHERE i.market_id = $1`,
    ],
    [
      'an aggregate',
      'function-not-allowed:count',
      `SELECT count(*) FROM "delivery"."delivery_events" i WHERE i.market_id = $1`,
    ],
    [
      'a set-returning function in FROM',
      'function-not-allowed:generate_series',
      `SELECT g FROM generate_series(1, 3) g`,
    ],
    [
      'a user schema function',
      'function-not-allowed:delivery.f',
      `SELECT delivery.f($2) FROM "delivery"."delivery_events" i WHERE i.market_id = $1`,
    ],
  ])('refuses %s', async (_name, violation, sql) => {
    expect(await check(sql, [{}])).toContain(violation);
  });

  it('allows pg_catalog.unnest but only over bound parameters', async () => {
    expect(
      await check(
        `SELECT u FROM pg_catalog.unnest($2::uuid[]) AS u, "delivery"."delivery_events" i WHERE i.market_id = $1`,
        [{}],
      ),
    ).toEqual([]);
    expect(
      await check(
        `SELECT u FROM unnest(ARRAY['a','b']) AS u, "delivery"."delivery_events" i WHERE i.market_id = $1`,
        [],
      ),
    ).toContain('unnest-argument-not-param');
  });

  it.each([
    [
      'no Market predicate on a join',
      `SELECT 1 FROM "delivery"."delivery_events" i JOIN "delivery"."deliveries" t ON t.id = i.type_id WHERE i.market_id = $1`,
      'market-rule:t',
    ],
    [
      'the Market only in WHERE for a joined table',
      `SELECT 1 FROM "delivery"."delivery_events" i JOIN "delivery"."deliveries" t ON t.id = i.type_id WHERE i.market_id = $1 AND t.market_id = $1`,
      'market-rule:t',
    ],
    [
      'the Market inside an OR',
      `SELECT 1 FROM "delivery"."delivery_events" i WHERE i.market_id = $1 OR i.id = $2`,
      'market-rule:i',
    ],
    [
      'no Market predicate at all',
      `SELECT 1 FROM "delivery"."delivery_events" i WHERE i.id = $1`,
      'market-rule:i',
    ],
    [
      'the Market of another alias',
      `SELECT 1 FROM "delivery"."delivery_events" i WHERE x.market_id = $1`,
      'market-rule:i',
    ],
    [
      'USING instead of ON',
      `SELECT 1 FROM "delivery"."delivery_events" i JOIN "delivery"."deliveries" t USING (id) WHERE i.market_id = $1`,
      'market-rule:t',
    ],
    [
      'the Market inside a subquery missing',
      `SELECT 1 FROM "delivery"."delivery_events" i WHERE i.market_id = $1 AND EXISTS (SELECT 1 FROM "delivery"."deliveries" t WHERE t.id = i.type_id)`,
      'market-rule:t',
    ],
  ])('refuses %s', async (_name, sql, violation) => {
    expect(await check(sql, [])).toContain(violation);
  });

  it('refuses the Market compared with a literal, an expression or another parameter', async () => {
    expect(
      await check(
        `SELECT 1 FROM "delivery"."delivery_events" i WHERE i.market_id = $1 AND i.market_id = 'AU'`,
        [],
      ),
    ).toContain('market-literal');
    expect(
      await check(
        `SELECT 1 FROM "delivery"."delivery_events" i WHERE i.market_id = $1 AND i.market_id = lower($2)`,
        [{}],
      ),
    ).toContain('market-compared-to-expression');
    expect(
      await check(
        `SELECT 1 FROM "delivery"."delivery_events" i WHERE i.market_id = $1 AND i.market_id = $2`,
        [{}],
      ),
    ).toContain('market-compared-to-other-param');
  });

  it('refuses parameters that do not match the declaration', async () => {
    const sql = `SELECT 1 FROM "delivery"."delivery_events" i WHERE i.market_id = $1 AND i.id = ANY($2::uuid[])`;
    expect(await check(sql, [])).toContain('param-undeclared:$2');
    expect(await check(sql, [{}, {}])).toContain('param-unused:$3');
    expect(
      await check(`SELECT 1 FROM "delivery"."delivery_events" i WHERE i.id = $2`, [{}]),
    ).toContain('market-parameter-missing');
  });

  it('fails closed when the parser throws', async () => {
    const result = await checkStatement(
      () => Promise.reject(new Error('WASM module not initialized')),
      { id: 'delivery.test', sql: GOOD, params: [{}, {}] },
      owner,
    );
    expect(result).toEqual(['parse-failed']);
  });

  it('refuses a recursive CTE', async () => {
    const result = await check(
      `WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n FROM r) SELECT n FROM r, "delivery"."delivery_events" i WHERE i.market_id = $1`,
      [],
    );
    expect(result).toContain('recursive-cte');
  });

  describe('set operations carry the Market rule on every arm (Mojtaba H1)', () => {
    const T = '"delivery"."deliveries"';
    const I = '"delivery"."delivery_events"';
    it.each([
      [
        'a bare UNION ALL',
        `SELECT t.id FROM ${T} t WHERE t.market_id = $1 UNION ALL SELECT u.id FROM ${I} u`,
        'market-rule:u',
      ],
      [
        'a parenthesised UNION',
        `(SELECT t.id FROM ${T} t WHERE t.market_id = $1) UNION (SELECT u.id FROM ${I} u)`,
        'market-rule:u',
      ],
      [
        'an EXCEPT inside a CTE',
        `WITH x AS (SELECT t.id FROM ${T} t WHERE t.market_id = $1 EXCEPT SELECT u.id FROM ${I} u) SELECT x.id FROM x`,
        'market-rule:u',
      ],
      [
        'an INTERSECT inside a WHERE subquery',
        `SELECT t.id FROM ${T} t WHERE t.market_id = $1 AND t.id IN (SELECT a.id FROM ${I} a WHERE a.market_id = $1 INTERSECT SELECT u.id FROM ${I} u)`,
        'market-rule:u',
      ],
      [
        'a nested set operation (left arm)',
        `SELECT t.id FROM ${T} t WHERE t.market_id = $1 UNION SELECT a.id FROM ${I} a WHERE a.market_id = $1 UNION SELECT u.id FROM ${I} u`,
        'market-rule:u',
      ],
    ])('refuses %s whose arm lacks the Market term', async (_name, sql, violation) => {
      expect(await check(sql, [])).toContain(violation);
    });

    it('passes a set operation whose arms all carry the term', async () => {
      expect(
        await check(
          `SELECT t.id FROM ${T} t WHERE t.market_id = $1 UNION ALL SELECT u.id FROM ${I} u WHERE u.market_id = $1`,
          [],
        ),
      ).toEqual([]);
    });
  });

  describe('Hassan review of PR 220', () => {
    const T = '"delivery"."deliveries"';
    const I = '"delivery"."delivery_events"';
    it.each([
      [
        'INTO in a set-operation arm',
        `SELECT t.id INTO t2 FROM ${T} t WHERE t.market_id = $1 UNION SELECT 1`,
        'select-into',
      ],
      [
        'a RIGHT JOIN (H-2)',
        `SELECT c.id FROM unnest($2::uuid[]) AS u(id) RIGHT JOIN ${T} c ON c.market_id = $1 AND c.id = u.id`,
        'join-type:JOIN_RIGHT',
      ],
      [
        'a FULL JOIN (H-2)',
        `WITH k AS (SELECT 1 AS x) SELECT c.id FROM k FULL JOIN ${T} c ON c.market_id = $1 AND false`,
        'join-type:JOIN_FULL',
      ],
      [
        'a CTE named inside a sub-select and used outside it (M-1)',
        `SELECT u.id FROM (WITH users AS (SELECT 1 AS id) SELECT id FROM users) s, users u WHERE $1::text IS NOT NULL`,
        'relation-unqualified:users',
      ],
      [
        'a CTE that reads its own name (M-1)',
        `WITH issuers AS (SELECT * FROM issuers) SELECT x.id FROM issuers x WHERE $1::text IS NOT NULL`,
        'relation-unqualified:issuers',
      ],
      [
        'a column alias list that renames a column to market_id (M-2)',
        `SELECT c.id FROM ${T} AS c(id, market_id) WHERE c.market_id = $1`,
        'relation-column-alias',
      ],
      [
        'a qualified operator (L-1)',
        `SELECT t.id FROM ${T} t WHERE t.market_id = $1 AND t.id OPERATOR(public.===) t.id`,
        'operator-not-allowed:public.===',
      ],
      [
        'a cast to regclass (L-1)',
        `SELECT t.id FROM ${T} t WHERE t.market_id = $1 AND 'pg_authid'::regclass IS NOT NULL`,
        'cast-not-allowed:regclass',
      ],
      [
        'market_id inside COALESCE (L-2)',
        `SELECT t.id FROM ${T} t WHERE COALESCE(t.market_id, 'AU') = 'AU' AND t.market_id = $1`,
        'market-column-misused',
      ],
    ])('refuses %s', async (_name, sql, violation) => {
      expect(await check(sql, [{}])).toContain(violation);
    });

    it('passes a LEFT JOIN with the term in its ON and a CTE used after its definition', async () => {
      expect(
        await check(
          `WITH w AS (SELECT t.id FROM ${T} t WHERE t.market_id = $1)
           SELECT w.id FROM w LEFT JOIN ${I} i ON i.market_id = $1 AND i.type_id = w.id`,
          [],
        ),
      ).toEqual([]);
    });

    it('refuses locking, INTO and the other table forms in the places the walk must reach', async () => {
      expect(
        await check(`SELECT t.id FROM ${T} t WHERE t.market_id = $1 FOR UPDATE`, []),
      ).toContain('locking-clause');
    });
  });

  describe('Hassan re-review of PR 220', () => {
    const A = '"delivery"."deliveries"';
    const B = '"delivery"."delivery_events"';
    it.each([
      [
        'a join alias with a column list (N-1)',
        `SELECT x.id FROM (${A} x JOIN (VALUES ($1::text)) v(m) ON true) AS x(id, a, b, market_id) WHERE x.market_id = $1`,
        'join-alias',
      ],
      [
        'a join alias over two tables (N-1)',
        `SELECT x.id FROM (${A} x JOIN ${B} y ON y.market_id = $1) AS x(i1, m1, s1, i2, market_id) WHERE x.market_id = $1`,
        'join-alias',
      ],
      [
        'a qualified operator on a sub-link (N-2)',
        `SELECT t.id FROM ${A} t WHERE t.market_id = $1 AND t.id OPERATOR(public.===) ANY (SELECT i.id FROM ${B} i WHERE i.market_id = $1)`,
        'operator-not-allowed:public.===',
      ],
      [
        'unnest with ORDER BY',
        `SELECT u.v FROM unnest($2::text[] ORDER BY 1) AS u(v), ${A} t WHERE t.market_id = $1`,
        'function-not-allowed:call-form',
      ],
    ])('refuses %s', async (_name, sql, violation) => {
      expect(await check(sql, [{}])).toContain(violation);
    });

    it('still passes an ANY sub-link with a plain operator', async () => {
      expect(
        await check(
          `SELECT t.id FROM ${A} t WHERE t.market_id = $1 AND t.id = ANY (SELECT i.type_id FROM ${B} i WHERE i.market_id = $1)`,
          [],
        ),
      ).toEqual([]);
    });
  });
});

describe('raw read statement check: full-text search (ADR-0030 amendment, search module)', () => {
  const searchOwner: StatementOwner = {
    schema: 'search',
    tables: new Set(['offer_documents']),
  };
  const checkSearch = (sql: string, params: readonly unknown[]): Promise<string[]> =>
    checkStatement(parseSql, { id: 'search.test', sql, params }, searchOwner);
  const base = (where: string): string =>
    `SELECT d.offer_id FROM "search"."offer_documents" d WHERE d.market_id = $1 AND ${where}`;
  const TSQ = 'websearch_to_tsquery($2::regconfig, $3::text)';

  it('passes the ranked text query, with and without the array containment', async () => {
    const sql = `SELECT d.offer_id, ts_rank(d.search_vector, ${TSQ}) AS rank
      FROM "search"."offer_documents" d
     WHERE d.market_id = $1 AND d.search_vector @@ ${TSQ} AND d.category_ids @> $4::uuid[]
     ORDER BY rank DESC LIMIT $5::text::int4`;
    expect(await checkSearch(sql, [{}, {}, {}, {}])).toEqual([]);
    expect(await checkSearch(base(`d.search_vector @@ ${TSQ}`), [{}, {}])).toEqual([]);
  });

  // Hassan's probes (PR review M-1) and the shapes around them: each construct only as used.
  it.each([
    ['@@ against a bare parameter', 'd.search_vector @@ $2', [{}], ['operator-shape:@@']],
    [
      '@@ against a cast tsquery',
      'd.search_vector @@ $2::text::tsquery',
      [{}],
      ['cast-not-allowed:tsquery', 'operator-shape:@@'],
    ],
    ['@@ on a non-vector shape', 'd.name @@ $2', [{}], ['operator-shape:@@']],
    [
      'regconfig on a cast parameter',
      '$2::text::regconfig IS NOT NULL',
      [{}],
      ['cast-not-allowed:regconfig'],
    ],
    ['@> against a bare parameter', 'd.category_ids @> $2', [{}], ['operator-shape:@>']],
    [
      'a column as the query text',
      'ts_rank(d.search_vector, websearch_to_tsquery($2::regconfig, d.name)) > 0',
      [{}],
      ['text-search-shape:websearch_to_tsquery'],
    ],
    [
      'ts_rank over a parameter',
      'ts_rank($2::text::tsvector, websearch_to_tsquery($3::regconfig, $4::text)) > 0',
      [{}, {}, {}],
      ['cast-not-allowed:tsvector', 'text-search-shape:ts_rank'],
    ],
    [
      'a literal configuration',
      "d.search_vector @@ websearch_to_tsquery('english', $2::text)",
      [{}],
      ['text-search-shape:websearch_to_tsquery'],
    ],
    [
      'a column cast to regconfig',
      'd.search_vector @@ websearch_to_tsquery(d.name::regconfig, $2::text)',
      [{}],
      ['cast-not-allowed:regconfig', 'text-search-shape:websearch_to_tsquery'],
    ],
    [
      'to_tsquery',
      'd.search_vector @@ to_tsquery($2::regconfig, $3::text)',
      [{}, {}],
      ['function-not-allowed:to_tsquery', 'operator-shape:@@'],
    ],
    ['another operator', 'd.name || $2::text = $3::text', [{}, {}], ['operator-not-allowed:||']],
    ['regclass', '$2::regclass IS NOT NULL', [{}], ['cast-not-allowed:regclass']],
  ])('refuses %s', async (_name, where, params, expected) => {
    expect(await checkSearch(base(where), params)).toEqual(expected);
  });

  it('keeps the Market rule: a text query without market_id = $1 is refused', async () => {
    expect(
      await checkSearch(
        `SELECT d.offer_id FROM "search"."offer_documents" d WHERE d.search_vector @@ ${TSQ}`,
        [{}, {}],
      ),
    ).toEqual(['market-parameter-missing', 'market-rule:d']);
  });
});
