import {
  findRoleProblems,
  ROLE_CONFIG_SQL,
  ROLE_PROBLEMS_SQL,
  roleTimeoutProblems,
  SESSION_TIMEOUTS_SQL,
  sessionTimeoutProblems,
  settingMilliseconds,
} from './database-role-check';

// docs/design/data/platform.md 10.8, reason `role_timeouts` (K1a): presence and ceiling of
// the three timeouts in the connected role's own settings.

const SET = ['statement_timeout=30s', 'lock_timeout=3s', 'idle_in_transaction_session_timeout=60s'];

describe('settingMilliseconds', () => {
  it.each([
    ['30s', 30_000],
    ['3000', 3_000],
    ['3000ms', 3_000],
    ['1min', 60_000],
    ['2.5s', 2_500],
    ['500 ms', 500],
    ['1h', 3_600_000],
    ['0', 0],
  ])('reads %s as %d ms', (value, ms) => {
    expect(settingMilliseconds(value)).toBe(ms);
  });

  it.each(['', 's', '3 seconds', '-1s', '3x', 'off', '1constructor', '1toString', '1__proto__'])(
    'cannot read %j',
    (value) => {
      expect(settingMilliseconds(value)).toBeNull();
    },
  );

  it('cannot read a value too large to be finite', () => {
    expect(settingMilliseconds(`${'9'.repeat(400)}d`)).toBeNull();
  });
});

describe('sessionTimeoutProblems (the values in force on the connection)', () => {
  const inForce = {
    statement_timeout: '30s',
    lock_timeout: '3s',
    idle_in_transaction_session_timeout: '1min',
  };

  it('accepts the K1a values as current_setting shows them', () => {
    expect(sessionTimeoutProblems(inForce)).toEqual([]);
  });

  it('refuses a timeout a connection option set to 0, or one above its ceiling', () => {
    expect(sessionTimeoutProblems({ ...inForce, statement_timeout: '0' })).toEqual([
      { code: 'role_timeouts', subject: 'session.statement_timeout' },
    ]);
    expect(sessionTimeoutProblems({ ...inForce, lock_timeout: '10s' })).toEqual([
      { code: 'role_timeouts', subject: 'session.lock_timeout' },
    ]);
  });

  it('refuses every timeout when the row is missing', () => {
    expect(sessionTimeoutProblems(undefined)).toHaveLength(3);
  });
});

describe('roleTimeoutProblems (10.8 role_timeouts)', () => {
  it('accepts the K1a values, other settings beside them, and lower values', () => {
    expect(roleTimeoutProblems(SET)).toEqual([]);
    expect(roleTimeoutProblems([...SET, 'plan_cache_mode=auto'])).toEqual([]);
    expect(
      roleTimeoutProblems([
        'statement_timeout=10000',
        'lock_timeout=500ms',
        'idle_in_transaction_session_timeout=1min',
      ]),
    ).toEqual([]);
  });

  it('refuses a role with no settings at all, naming each missing timeout', () => {
    const missing = [
      { code: 'role_timeouts', subject: 'statement_timeout' },
      { code: 'role_timeouts', subject: 'lock_timeout' },
      { code: 'role_timeouts', subject: 'idle_in_transaction_session_timeout' },
    ];
    expect(roleTimeoutProblems(null)).toEqual(missing);
    expect(roleTimeoutProblems([])).toEqual(missing);
  });

  it.each([
    ['zero (disabled)', 'lock_timeout=0'],
    ['above its ceiling', 'lock_timeout=3001ms'],
    ['above its ceiling, in another unit', 'lock_timeout=1min'],
    ['unreadable', 'lock_timeout=soon'],
  ])('refuses a timeout that is %s', (_case, entry) => {
    const config = SET.map((setting) => (setting.startsWith('lock_timeout=') ? entry : setting));
    expect(roleTimeoutProblems(config)).toEqual([
      { code: 'role_timeouts', subject: 'lock_timeout' },
    ]);
  });

  it('accepts a value at its ceiling exactly', () => {
    expect(
      roleTimeoutProblems([
        'statement_timeout=30000ms',
        'lock_timeout=3000',
        'idle_in_transaction_session_timeout=1min',
      ]),
    ).toEqual([]);
  });
});

describe('findRoleProblems', () => {
  it('runs the three queries and appends the role_timeouts problems', async () => {
    const asked: string[] = [];
    const answers: Record<string, Record<string, unknown>[]> = {
      [ROLE_PROBLEMS_SQL]: [{ code: 'create_on_database', subject: null }],
      [ROLE_CONFIG_SQL]: [{ rolconfig: SET.filter((s) => !s.startsWith('statement_timeout')) }],
      [SESSION_TIMEOUTS_SQL]: [
        {
          statement_timeout: '30s',
          lock_timeout: '0',
          idle_in_transaction_session_timeout: '1min',
        },
      ],
    };
    const problems = await findRoleProblems((sql) => {
      asked.push(sql);
      return Promise.resolve(answers[sql] ?? []);
    });

    expect(asked).toEqual([ROLE_PROBLEMS_SQL, ROLE_CONFIG_SQL, SESSION_TIMEOUTS_SQL]);
    expect(problems).toEqual([
      { code: 'create_on_database', subject: null },
      { code: 'role_timeouts', subject: 'statement_timeout' },
      { code: 'role_timeouts', subject: 'session.lock_timeout' },
    ]);
  });

  it('refuses when the role row is missing', async () => {
    const problems = await findRoleProblems(() => Promise.resolve([]));

    expect(problems.map((p) => p.code)).toEqual(Array(6).fill('role_timeouts'));
  });
});
