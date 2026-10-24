// The parse check of a raw read statement (ADR-0030 decisions 3 to 5). Pure: no I/O, no
// database, and no import (the parser is handed in), so the boot re-check and
// `scripts/check-prisma-boundaries.mjs` run exactly this code. It fails closed: whatever the
// check cannot read is a violation, and a parser that throws is a violation too (Hassan I-1).
//
// A violation is a short code with at most a table or function name from the static text. It
// never holds a parameter value.

/** What the parser answers: `libpg-query`'s tree (an untyped JSON value). */
export interface ParsedSql {
  readonly stmts?: readonly { readonly stmt?: unknown }[];
}
export type ParseSql = (sql: string) => Promise<ParsedSql>;

/** The part of a list entry the check reads. */
export interface CheckedStatement {
  readonly id: string;
  readonly sql: string;
  /** The declared parameters, `$2` onwards in this order (`$1` is the Market). */
  readonly params: readonly unknown[];
}

/** The owner's side: its schema and the tables of its Prisma models. */
export interface StatementOwner {
  readonly schema: string;
  readonly tables: ReadonlySet<string>;
}

type Node = Record<string, unknown>;

/** The only functions a statement may call (ADR-0030 decision 3). */
const ALLOWED_FUNCTIONS: readonly (readonly string[])[] = [
  ['unnest'],
  ['pg_catalog', 'unnest'],
  // Full-text search (ADR-0030 amendment, `search` module): pure, read-only and deterministic.
  ['websearch_to_tsquery'],
  ['ts_rank'],
];

/** The text-search functions; each is allowed in one exact shape only (see `checkFunction`). */
const TEXT_SEARCH_FUNCTIONS: ReadonlySet<string> = new Set(['websearch_to_tsquery', 'ts_rank']);

/** The comparison operators a statement may use; a qualified or other operator is refused. */
const ALLOWED_OPERATORS: ReadonlySet<string> = new Set([
  '=',
  '<>',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '~~',
  '~~*',
  '!~~',
  '!~~*',
  // Text search match and array containment (ADR-0030 amendment, `search` module).
  '@@',
  '@>',
]);

/** The types a cast may name (`pg_catalog` or unqualified); anything else is refused. */
const ALLOWED_CAST_TYPES: ReadonlySet<string> = new Set([
  'uuid',
  'text',
  'bool',
  'int4',
  'int8',
  'timestamptz',
  'date',
  'varchar',
  'numeric',
  // A text search configuration named by a bound parameter (`search` module).
  'regconfig',
]);

/** Node kinds that are refused wherever they appear (decision 4 and the function rule). */
const REFUSED_NODES: ReadonlyMap<string, string> = new Map([
  ['LockingClause', 'locking-clause'],
  ['IntoClause', 'select-into'],
  ['RangeTableFunc', 'table-function'],
  ['JsonTable', 'table-function'],
  ['RangeTableSample', 'table-sample'],
]);

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const only = (value: unknown): [string, unknown] | null => {
  if (!isNode(value)) return null;
  const keys = Object.keys(value);
  return keys.length === 1 ? [keys[0]!, value[keys[0]!]] : null;
};

/** The `sval` strings of a list of `String` nodes (a name or a column path). */
function strings(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null;
  const names: string[] = [];
  for (const item of list) {
    const entry = only(item);
    if (entry === null || entry[0] !== 'String' || !isNode(entry[1])) return null;
    const sval = entry[1].sval;
    if (typeof sval !== 'string') return null;
    names.push(sval);
  }
  return names;
}

/** `[alias, "market_id"]` or `["market_id"]` column path: the alias, or null. */
function marketColumnAlias(node: unknown): string | null | undefined {
  const entry = only(node);
  if (entry === null || entry[0] !== 'ColumnRef' || !isNode(entry[1])) return undefined;
  const path = strings(entry[1].fields);
  if (path === null || path.length === 0 || path[path.length - 1] !== 'market_id') return undefined;
  return path.length === 2 ? path[0]! : null;
}

const isParam1 = (node: unknown): boolean => {
  const entry = only(node);
  return entry !== null && entry[0] === 'ParamRef' && isNode(entry[1]) && entry[1].number === 1;
};

/** The top-level `AND` terms of a condition (a lone term is its own list). */
function termsOf(condition: unknown): unknown[] {
  const entry = only(condition);
  if (entry === null) return condition === undefined || condition === null ? [] : [condition];
  if (entry[0] === 'BoolExpr' && isNode(entry[1]) && entry[1].boolop === 'AND_EXPR') {
    return Array.isArray(entry[1].args) ? entry[1].args.flatMap(termsOf) : [];
  }
  return [condition];
}

/** True when a term is `<alias>.market_id = $1` (either side first). */
function isMarketTerm(term: unknown, alias: string): boolean {
  const entry = only(term);
  if (entry === null || entry[0] !== 'A_Expr' || !isNode(entry[1])) return false;
  const expr = entry[1];
  if (expr.kind !== 'AEXPR_OP' || strings(expr.name)?.join('.') !== '=') return false;
  return (
    (marketColumnAlias(expr.lexpr) === alias && isParam1(expr.rexpr)) ||
    (marketColumnAlias(expr.rexpr) === alias && isParam1(expr.lexpr))
  );
}

interface Walk {
  readonly owner: StatementOwner;
  readonly violations: Set<string>;
  readonly paramNumbers: Set<number>;
  /** The CTE names visible at the select being walked (scoped, see `visitSelect`). */
  cteNames: Set<string>;
  /** `market_id` column nodes that are a direct operand of a comparison (Hassan L-2). */
  readonly comparedMarketColumns: WeakSet<object>;
}

function relationName(rangeVar: Node): { schema: string | null; name: string; alias: string } {
  const name = typeof rangeVar.relname === 'string' ? rangeVar.relname : '';
  const schema = typeof rangeVar.schemaname === 'string' ? rangeVar.schemaname : null;
  const aliasNode = isNode(rangeVar.alias) ? rangeVar.alias : null;
  const alias = typeof aliasNode?.aliasname === 'string' ? aliasNode.aliasname : name;
  return { schema, name, alias };
}

/** Decision 3: own schema, a table of the owner's models, qualified (a CTE name is exempt). */
function checkRelation(rangeVar: Node, walk: Walk): void {
  const { schema, name } = relationName(rangeVar);
  // A column alias list can rename another column to `market_id` (Hassan M-2).
  if (isNode(rangeVar.alias) && rangeVar.alias.colnames !== undefined) {
    walk.violations.add('relation-column-alias');
  }
  if (schema === null) {
    if (!walk.cteNames.has(name)) walk.violations.add(`relation-unqualified:${name}`);
    return;
  }
  if (schema !== walk.owner.schema) walk.violations.add(`relation-schema:${schema}.${name}`);
  else if (!walk.owner.tables.has(name)) walk.violations.add(`relation-not-owner-table:${name}`);
}

/**
 * Decision 5, the Market rule: `<alias>.market_id = $1` is a top-level `AND` term of the
 * relation's own `ON` clause, or of `WHERE` for a `FROM` root. Calls and subselects in `FROM`
 * are exempt as relations (their inner selects are checked on their own).
 */
function checkFrom(item: unknown, quals: unknown, walk: Walk): void {
  const entry = only(item);
  if (entry === null) {
    walk.violations.add('from-item-unreadable');
    return;
  }
  const [kind, body] = entry;
  if (kind === 'JoinExpr' && isNode(body)) {
    // A join alias hides the inner aliases and can rename a column to market_id (Hassan N-1).
    if (body.alias !== undefined) walk.violations.add('join-alias');
    // An ON term filters nothing on the preserved side of a RIGHT or FULL join (Hassan H-2).
    if (body.jointype !== 'JOIN_INNER' && body.jointype !== 'JOIN_LEFT') {
      walk.violations.add(`join-type:${String(body.jointype)}`);
    }
    checkFrom(body.larg, quals, walk);
    checkFrom(body.rarg, body.quals, walk);
    return;
  }
  if (kind === 'RangeVar' && isNode(body)) {
    const { schema, name, alias } = relationName(body);
    if (schema === null && walk.cteNames.has(name)) return;
    if (!termsOf(quals).some((term) => isMarketTerm(term, alias))) {
      walk.violations.add(`market-rule:${alias}`);
    }
    return;
  }
  if (kind !== 'RangeFunction' && kind !== 'RangeSubselect') {
    walk.violations.add(`from-item-unsupported:${kind}`);
  }
}

/** A column reference such as `d.search_vector`. */
function isColumn(node: unknown): boolean {
  const entry = only(node);
  return (
    entry !== null &&
    entry[0] === 'ColumnRef' &&
    isNode(entry[1]) &&
    strings(entry[1].fields) !== null
  );
}

/** `$n::<type>`: a cast whose operand is a bound parameter directly (`$1`, the Market, excluded). */
function isParamCast(node: unknown, type: string): boolean {
  const entry = only(node);
  if (entry === null || entry[0] !== 'TypeCast' || !isNode(entry[1])) return false;
  const target = isNode(entry[1].typeName) ? strings(entry[1].typeName.names) : null;
  const param = only(entry[1].arg);
  return (
    target !== null &&
    target[target.length - 1] === type &&
    param !== null &&
    param[0] === 'ParamRef' &&
    isNode(param[1]) &&
    typeof param[1].number === 'number' &&
    param[1].number >= 2
  );
}

/** `websearch_to_tsquery(...)` as an operand; its own arguments are checked when it is visited. */
function isTsQueryCall(node: unknown): boolean {
  const entry = only(node);
  return (
    entry !== null &&
    entry[0] === 'FuncCall' &&
    isNode(entry[1]) &&
    strings(entry[1].funcname)?.join('.') === 'websearch_to_tsquery'
  );
}

function checkCast(cast: Node, walk: Walk): void {
  const target = isNode(cast.typeName) ? strings(cast.typeName.names) : null;
  const name = target?.[target.length - 1];
  const qualified = target !== null && target.length === 2 && target[0] === 'pg_catalog';
  const ok =
    target !== null &&
    name !== undefined &&
    (target.length === 1 || qualified) &&
    ALLOWED_CAST_TYPES.has(name);
  // `regconfig` only on a bound parameter cast directly (never a column or an expression).
  const direct = name !== 'regconfig' || only(cast.arg)?.[0] === 'ParamRef';
  if (!ok || !direct) {
    walk.violations.add(`cast-not-allowed:${target === null ? '?' : target.join('.')}`);
  }
}

function checkFunction(call: Node, walk: Walk): void {
  const name = strings(call.funcname);
  const allowed =
    name !== null &&
    ALLOWED_FUNCTIONS.some((f) => f.length === name.length && f.every((p, i) => p === name[i]));
  if (!allowed) {
    walk.violations.add(`function-not-allowed:${name === null ? '?' : name.join('.')}`);
    return;
  }
  const args = Array.isArray(call.args) ? call.args : [];
  if (name !== null && TEXT_SEARCH_FUNCTIONS.has(name[name.length - 1]!)) {
    // Exact shapes only (ADR-0030 amendment): ts_rank(<column>, websearch_to_tsquery(...)) and
    // websearch_to_tsquery($n::regconfig, $m::text), both arguments casts of bound parameters.
    const last = name[name.length - 1]!;
    const shaped =
      name.length === 1 &&
      args.length === 2 &&
      (last === 'ts_rank'
        ? isColumn(args[0]) && isTsQueryCall(args[1])
        : isParamCast(args[0], 'regconfig') && isParamCast(args[1], 'text'));
    if (!shaped) walk.violations.add(`text-search-shape:${last}`);
  } else {
    // `unnest` only over bound parameters (optionally cast).
    for (const arg of args) {
      let inner: unknown = arg;
      const cast = only(inner);
      if (cast !== null && cast[0] === 'TypeCast' && isNode(cast[1])) inner = cast[1].arg;
      const param = only(inner);
      if (param === null || param[0] !== 'ParamRef') {
        walk.violations.add('unnest-argument-not-param');
      }
    }
  }
  if (
    call.agg_star === true ||
    call.agg_distinct === true ||
    call.over !== undefined ||
    call.agg_order !== undefined ||
    call.agg_filter !== undefined ||
    call.func_variadic === true
  ) {
    walk.violations.add('function-not-allowed:call-form');
  }
}

/** The checks of one select body that need no walk: locking, INTO, CTE shape, Market rule. */
function checkSelect(select: Node, walk: Walk): void {
  const locking = select.lockingClause;
  if (Array.isArray(locking) && locking.length > 0) walk.violations.add('locking-clause');
  if (select.intoClause !== undefined) walk.violations.add('select-into');
  const withClause = isNode(select.withClause) ? select.withClause : null;
  if (withClause !== null && withClause.recursive === true) walk.violations.add('recursive-cte');
  const from = Array.isArray(select.fromClause) ? select.fromClause : [];
  for (const item of from) checkFrom(item, select.whereClause, walk);
}

/**
 * A select body, plain or a UNION/INTERSECT/EXCEPT arm (arms are bare bodies, with no
 * SelectStmt wrapper; Mojtaba H1, Hassan H-1). CTE names are scoped as PostgreSQL scopes them:
 * a name is visible to later siblings and to the select itself, never to its own body or to an
 * earlier sibling, and leaves scope with the select (Hassan M-1).
 */
function visitSelect(select: Node, walk: Walk): void {
  const outer = walk.cteNames;
  walk.cteNames = new Set(outer);
  const withClause = isNode(select.withClause) ? select.withClause : null;
  for (const cte of Array.isArray(withClause?.ctes) ? withClause.ctes : []) {
    const entry = only(cte);
    if (entry === null || entry[0] !== 'CommonTableExpr' || !isNode(entry[1])) {
      walk.violations.add('from-item-unreadable');
      continue;
    }
    const query = only(entry[1].ctequery);
    if (query === null || query[0] !== 'SelectStmt') walk.violations.add('data-modifying-cte');
    visit({ ctequery: entry[1].ctequery }, walk);
    if (typeof entry[1].ctename === 'string') walk.cteNames.add(entry[1].ctename);
  }
  const setOperation = select.op !== undefined && select.op !== 'SETOP_NONE';
  checkSelect(select, walk);
  for (const [key, child] of Object.entries(select)) {
    if (key === 'withClause') continue;
    if (setOperation && (key === 'larg' || key === 'rarg')) {
      if (isNode(child)) visitSelect(child, walk);
      else walk.violations.add('from-item-unreadable');
    } else {
      visit({ [key]: child }, walk);
    }
  }
  walk.cteNames = outer;
}

function visit(value: unknown, walk: Walk): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, walk);
    return;
  }
  if (!isNode(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const refused = REFUSED_NODES.get(key);
    if (refused !== undefined) walk.violations.add(refused);
    else if (key.endsWith('Stmt') && key !== 'SelectStmt') walk.violations.add(`statement:${key}`);
    if (!isNode(child)) {
      visit(child, walk);
      continue;
    }
    switch (key) {
      case 'SelectStmt':
        visitSelect(child, walk);
        continue;
      case 'RangeVar':
        checkRelation(child, walk);
        break;
      case 'FuncCall':
        checkFunction(child, walk);
        break;
      case 'SubLink': {
        const operator = child.operName === undefined ? [] : strings(child.operName);
        if (
          operator === null ||
          (operator.length > 0 && (operator.length !== 1 || !ALLOWED_OPERATORS.has(operator[0]!)))
        ) {
          walk.violations.add(
            `operator-not-allowed:${operator === null ? '?' : operator.join('.')}`,
          );
        }
        break;
      }
      case 'ColumnRef':
        // `market_id` is only ever a direct operand of a comparison (Hassan L-2).
        if (
          marketColumnAlias({ ColumnRef: child }) !== undefined &&
          !walk.comparedMarketColumns.has(child)
        ) {
          walk.violations.add('market-column-misused');
        }
        break;
      case 'TypeCast':
        checkCast(child, walk);
        break;
      case 'ParamRef':
        if (typeof child.number === 'number') walk.paramNumbers.add(child.number);
        else walk.violations.add('param-unreadable');
        break;
      case 'A_Expr': {
        const operator = strings(child.name);
        if (operator === null || operator.length !== 1 || !ALLOWED_OPERATORS.has(operator[0]!)) {
          walk.violations.add(
            `operator-not-allowed:${operator === null ? '?' : operator.join('.')}`,
          );
        }
        const shaped =
          operator?.[0] === '@@'
            ? isColumn(child.lexpr) && isTsQueryCall(child.rexpr)
            : operator?.[0] === '@>'
              ? isColumn(child.lexpr) && isParamCast(child.rexpr, 'uuid')
              : true;
        if (!shaped) walk.violations.add(`operator-shape:${operator?.[0] ?? '?'}`);
        for (const operand of [child.lexpr, child.rexpr]) {
          const column = only(operand);
          if (column !== null && column[0] === 'ColumnRef' && isNode(column[1])) {
            walk.comparedMarketColumns.add(column[1]);
          }
        }
        // `market_id` is compared with `$1`, never with a literal or another expression.
        for (const [side, other] of [
          [child.lexpr, child.rexpr],
          [child.rexpr, child.lexpr],
        ] as const) {
          if (marketColumnAlias(side) !== undefined) {
            const literal = only(other);
            if (literal !== null && literal[0] === 'A_Const') walk.violations.add('market-literal');
            else if (literal !== null && literal[0] !== 'ColumnRef' && literal[0] !== 'ParamRef') {
              walk.violations.add('market-compared-to-expression');
            } else if (literal !== null && literal[0] === 'ParamRef' && !isParam1(other)) {
              walk.violations.add('market-compared-to-other-param');
            }
          }
        }
        break;
      }
      default:
        break;
    }
    visit(child, walk);
  }
}

/**
 * Checks one statement against decisions 3 to 5. Returns the violations (sorted, empty when
 * the statement passes). A parse failure of any kind is a violation: the check fails closed.
 */
export async function checkStatement(
  parse: ParseSql,
  statement: CheckedStatement,
  owner: StatementOwner,
): Promise<string[]> {
  let parsed: ParsedSql;
  try {
    parsed = await parse(statement.sql);
  } catch {
    return ['parse-failed'];
  }
  const stmts = parsed?.stmts;
  if (!Array.isArray(stmts) || stmts.length !== 1) return ['not-one-statement'];
  const root = only((stmts[0] as { stmt?: unknown } | undefined)?.stmt);
  if (root === null || root[0] !== 'SelectStmt') return ['not-a-select'];

  const walk: Walk = {
    owner,
    violations: new Set(),
    paramNumbers: new Set(),
    cteNames: new Set(),
    comparedMarketColumns: new WeakSet(),
  };
  visit({ SelectStmt: root[1] }, walk);

  // Parameters: `$1` is the Market and is required; `$2..` are exactly the declared ones.
  if (!walk.paramNumbers.has(1)) walk.violations.add('market-parameter-missing');
  for (let n = 2; n <= statement.params.length + 1; n += 1) {
    if (!walk.paramNumbers.has(n)) walk.violations.add(`param-unused:$${n}`);
  }
  for (const n of walk.paramNumbers) {
    if (!Number.isInteger(n) || n < 1 || n > statement.params.length + 1) {
      walk.violations.add(`param-undeclared:$${n}`);
    }
  }
  return [...walk.violations].sort();
}
