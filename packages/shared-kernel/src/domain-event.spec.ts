import {
  checkAggregateVersion,
  defineEvent,
  describeEventDefinition,
  encodePayload,
  eventField,
  MAX_AGGREGATE_VERSION,
  MAX_ENUM_VALUES,
} from './domain-event';
import type { Id } from './id';
import { Temporal } from './time';

const ACCOUNT_ID = '01920000-0000-7000-8000-000000000001' as Id<'account'>;
const SELLER_ID = '01920000-0000-7000-8000-000000000002' as Id<'seller'>;
const AT = Temporal.Instant.from('2026-10-07T01:02:03.004Z');

const accountChanged = defineEvent({
  type: 'identity.account-changed.v2',
  aggregateType: 'account',
  payload: {
    accountId: eventField.id(),
    status: eventField.enumOf(['active', 'disabled'] as const),
    verified: eventField.boolean(),
    attempts: eventField.integer(),
    changedAt: eventField.instant(),
    granted: eventField.listOf(eventField.permissionKey()),
    sellerId: eventField.optional(eventField.id()),
  },
});

const validPayload = {
  accountId: ACCOUNT_ID,
  status: 'active' as const,
  verified: true,
  attempts: 3,
  changedAt: AT,
  granted: ['catalog.product.edit'],
  sellerId: null,
};

const known = { isKnownPermissionKey: (key: string) => key === 'catalog.product.edit' };

describe('defineEvent (platform persistence design 5.3)', () => {
  it('names the module, the version, the aggregate type and the fields', () => {
    expect(accountChanged.type).toBe('identity.account-changed.v2');
    expect(accountChanged.module).toBe('identity');
    expect(accountChanged.version).toBe(2);
    expect(accountChanged.aggregateType).toBe('account');
    expect(Object.keys(accountChanged.fields)).toEqual(Object.keys(validPayload));
    expect(Object.isFrozen(accountChanged)).toBe(true);
    expect(Object.isFrozen(accountChanged.fields)).toBe(true);
  });

  it('accepts a module name with a hyphen', () => {
    const event = defineEvent({
      type: 'commission-payouts.payout-sent.v1',
      aggregateType: 'payout',
      payload: { payoutId: eventField.id() },
    });

    expect(event.module).toBe('commission-payouts');
  });

  it.each([
    ['no version', 'identity.account-changed'],
    ['version 0', 'identity.account-changed.v0'],
    ['a leading zero', 'identity.account-changed.v01'],
    ['no subject', 'identity.v1'],
    ['upper case', 'identity.Account-changed.v1'],
    ['a space', 'identity.account changed.v1'],
    ['three segments before the version', 'identity.account.changed.v1'],
  ])('refuses a type with %s', (_case, type) => {
    expect(() => defineEvent({ type, aggregateType: 'account', payload: {} })).toThrow(TypeError);
  });

  it.each(['', 'Account', 'account_type', '1account', 'identity.account'])(
    'refuses the aggregate type %j',
    (aggregateType) => {
      expect(() =>
        defineEvent({ type: 'identity.account-changed.v1', aggregateType, payload: {} }),
      ).toThrow(TypeError);
    },
  );

  it.each(['', 'Account', 'account_id', '1st', 'a-b'])('refuses the field name %j', (name) => {
    expect(() =>
      defineEvent({
        type: 'identity.account-changed.v1',
        aggregateType: 'account',
        payload: { [name]: eventField.id() },
      }),
    ).toThrow(TypeError);
  });

  it.each<[string, readonly string[]]>([
    ['no value', []],
    ['a sentence', ['the account was disabled by an admin']],
    ['upper case', ['Active']],
    ['a duplicate', ['active', 'active']],
    ['an over-long code', ['a'.repeat(65)]],
  ])('refuses enumOf with %s (literal codes only, PH2)', (_case, values) => {
    expect(() => eventField.enumOf(values as [string, ...string[]])).toThrow(TypeError);
  });

  it('refuses enumOf with more values than MAX_ENUM_VALUES, before copying any', () => {
    let reads = 0;
    const huge = new Proxy(['active'], {
      get: (target, property, receiver) => {
        if (property === 'length') return 2 ** 32 - 1;
        if (/^\d+$/.test(String(property))) reads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    expect(() => eventField.enumOf(huge as unknown as [string])).toThrow(TypeError);
    expect(reads).toBe(0);
    expect(() =>
      eventField.enumOf(Array.from({ length: MAX_ENUM_VALUES + 1 }, (_, i) => `v${i}`) as [string]),
    ).toThrow(TypeError);
  });

  describe('enumOf copies its values once, then checks and freezes that copy (Hassan R2)', () => {
    /** An array whose iterator yields codes on its first pass and free text after it. */
    function trickyValues(stored: readonly string[]) {
      const counters = { iterator: 0, species: 0 };
      class Tricky extends Array<string> {
        static override get [Symbol.species](): ArrayConstructor {
          counters.species += 1;
          return Array;
        }
        override [Symbol.iterator](): ArrayIterator<string> {
          counters.iterator += 1;
          return (counters.iterator === 1 ? ['active', 'disabled'] : ['Free Text', 'disabled'])[
            Symbol.iterator
          ]();
        }
      }
      const values = new Tricky();
      for (const value of stored) Array.prototype.push.call(values, value);
      return { values: values as unknown as [string, ...string[]], counters };
    }

    it('keeps the indexed values in a plain frozen array, never consulting the iterator or species', () => {
      const { values, counters } = trickyValues(['active', 'disabled']);
      const kind = eventField.enumOf(values);

      expect(kind.values).toEqual(['active', 'disabled']);
      expect(kind.values).not.toBe(values);
      expect(Object.getPrototypeOf(kind.values)).toBe(Array.prototype);
      expect(Object.isFrozen(kind.values)).toBe(true);
      expect(counters).toEqual({ iterator: 0, species: 0 });
    });

    it('refuses free text at an index, whatever the iterator yields', () => {
      const { values } = trickyValues(['Free Text', 'disabled']);

      expect(() => eventField.enumOf(values)).toThrow(TypeError);
    });

    it('refuses a duplicate at an index, whatever the iterator yields', () => {
      const { values } = trickyValues(['active', 'active']);

      expect(() => eventField.enumOf(values)).toThrow(/distinct/);
    });
  });

  it.each([
    ['optional inside optional', eventField.optional(eventField.optional(eventField.id()))],
    ['optional inside a list', eventField.listOf(eventField.optional(eventField.id()))],
    ['a list of lists', eventField.listOf(eventField.listOf(eventField.id()))],
  ])('refuses %s', (_case, kind) => {
    expect(() =>
      defineEvent({
        type: 'identity.account-changed.v1',
        aggregateType: 'account',
        payload: { field: kind },
      }),
    ).toThrow(TypeError);
  });

  it('offers no kind that takes an arbitrary string', () => {
    expect(Object.keys(eventField).sort()).toEqual([
      'boolean',
      'enumOf',
      'id',
      'instant',
      'integer',
      'listOf',
      'optional',
      'permissionKey',
    ]);
  });

  it('refuses a field that is not a kind of the vocabulary', () => {
    expect(() =>
      defineEvent({
        type: 'identity.account-changed.v1',
        aggregateType: 'account',
        payload: { reason: { kind: 'string' } as never },
      }),
    ).toThrow(TypeError);
  });
});

describe('record: the PendingEvent an aggregate produces (5.1)', () => {
  it('carries type, aggregate type, id, version, instant and payload, frozen', () => {
    const pending = accountChanged.record({
      aggregateId: ACCOUNT_ID,
      aggregateVersion: 4,
      occurredAt: AT,
      payload: validPayload,
    });

    expect(pending).toEqual({
      type: 'identity.account-changed.v2',
      aggregateType: 'account',
      aggregateId: ACCOUNT_ID,
      aggregateVersion: 4,
      occurredAt: AT,
      payload: validPayload,
    });
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending.payload)).toBe(true);
  });

  it.each([0, -1, 1.5, MAX_AGGREGATE_VERSION + 1, Number.NaN])(
    'throws on the aggregate version %p',
    (aggregateVersion) => {
      expect(() =>
        accountChanged.record({
          aggregateId: ACCOUNT_ID,
          aggregateVersion,
          occurredAt: AT,
          payload: validPayload,
        }),
      ).toThrow(RangeError);
    },
  );
});

describe('checkAggregateVersion', () => {
  it('accepts 1 to 2^31 - 1 only', () => {
    expect(checkAggregateVersion(1)).toBe(true);
    expect(checkAggregateVersion(MAX_AGGREGATE_VERSION)).toBe(true);
    expect(MAX_AGGREGATE_VERSION).toBe(2 ** 31 - 1);
    expect(checkAggregateVersion(0)).toBe(false);
    expect(checkAggregateVersion(2 ** 31)).toBe(false);
    expect(checkAggregateVersion('1' as unknown as number)).toBe(false);
  });
});

describe('encodePayload: the run-time check and the jsonb form (5.3)', () => {
  it('encodes exactly the declared fields: instants as ISO strings, null for an absent optional', () => {
    const encoded = encodePayload(accountChanged.fields, validPayload, known);

    expect(encoded).toEqual({
      ok: true,
      value: {
        accountId: ACCOUNT_ID,
        status: 'active',
        verified: true,
        attempts: 3,
        changedAt: '2026-10-07T01:02:03.004Z',
        granted: ['catalog.product.edit'],
        sellerId: null,
      },
    });
  });

  it('accepts an optional field with a value, and an absent optional key', () => {
    const withoutOptional: Record<string, unknown> = { ...validPayload };
    delete withoutOptional.sellerId;

    expect(
      encodePayload(accountChanged.fields, { ...validPayload, sellerId: SELLER_ID }, known),
    ).toMatchObject({ ok: true, value: { sellerId: SELLER_ID } });
    expect(encodePayload(accountChanged.fields, withoutOptional, known)).toMatchObject({
      ok: true,
      value: { sellerId: null },
    });
  });

  it.each<[string, Record<string, unknown>, string | null, string]>([
    ['an undeclared field, without echoing its key', { reason: 'free text' }, null, 'undeclared'],
    ['a missing field', { accountId: undefined }, 'accountId', 'missing'],
    ['a malformed id', { accountId: 'not-a-uuid' }, 'accountId', 'invalid'],
    [
      'an id that is a version 4 UUID',
      { accountId: '9b2e1c55-0d5e-4b7e-8d3a-1c2b3a4d5e6f' },
      'accountId',
      'invalid',
    ],
    ['an enum value not declared', { status: 'deleted' }, 'status', 'invalid'],
    ['a boolean as a string', { verified: 'true' }, 'verified', 'invalid'],
    ['a fraction', { attempts: 1.5 }, 'attempts', 'invalid'],
    ['an integer above 2^53', { attempts: 2 ** 53 }, 'attempts', 'invalid'],
    ['an instant as a string', { changedAt: '2026-10-07T00:00:00Z' }, 'changedAt', 'invalid'],
    ['an unknown permission key', { granted: ['catalog.product.delete'] }, 'granted', 'invalid'],
    ['a list that is not an array', { granted: 'catalog.product.edit' }, 'granted', 'invalid'],
    ['null for a required field', { verified: null }, 'verified', 'missing'],
  ])(
    'refuses %s, naming only a declared field and never the value',
    (_case, change, field, problem) => {
      const result = encodePayload(accountChanged.fields, { ...validPayload, ...change }, known);

      expect(result).toEqual({
        ok: false,
        error: { code: 'event-payload.invalid', field, problem },
      });
    },
  );

  it('refuses a payload that is not a plain object', () => {
    for (const payload of [null, [], 'text', new Map()]) {
      expect(encodePayload(accountChanged.fields, payload, known)).toEqual({
        ok: false,
        error: { code: 'event-payload.invalid', field: null, problem: 'not-an-object' },
      });
    }
  });

  it('writes an instant through the prototype, not the value (Hassan L1 on slice 6a)', () => {
    class Forged extends Temporal.Instant {
      override toString(): string {
        return 'not an instant';
      }
    }
    const fake = Object.create(Temporal.Instant.prototype, {
      toString: { value: () => '2026-10-07T01:02:03.004Z' },
    }) as unknown;
    const only = { changedAt: eventField.instant() };

    expect(encodePayload(only, { changedAt: new Forged(AT.epochNanoseconds) }, known)).toEqual({
      ok: true,
      value: { changedAt: '2026-10-07T01:02:03.004Z' },
    });
    expect(encodePayload(only, { changedAt: fake }, known)).toEqual({
      ok: false,
      error: { code: 'event-payload.invalid', field: 'changedAt', problem: 'invalid' },
    });
  });

  it('refuses every permission key when no registry knows one (fail closed)', () => {
    const result = encodePayload(accountChanged.fields, validPayload, {
      isKnownPermissionKey: () => false,
    });

    expect(result).toMatchObject({ ok: false, error: { field: 'granted' } });
  });
});

describe('describeEventDefinition: the catalogue snapshot form', () => {
  it('describes each field by its kind, with enum values in declared order', () => {
    expect(describeEventDefinition(accountChanged)).toEqual({
      type: 'identity.account-changed.v2',
      aggregateType: 'account',
      fields: {
        accountId: 'id',
        status: 'enumOf(active|disabled)',
        verified: 'boolean',
        attempts: 'integer',
        changedAt: 'instant',
        granted: 'listOf(permissionKey)',
        sellerId: 'optional(id)',
      },
    });
  });
});
