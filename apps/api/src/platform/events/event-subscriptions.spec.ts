import { defineEvent, eventField } from '@mondapac-drive/shared-kernel';
import { decodePayload } from './decode-payload';
import { backOffSeconds, MAX_DELIVERY_ATTEMPTS } from './event-delivery';
import {
  subscription,
  SubscriptionRegistry,
  SubscriptionRegistryError,
  type RegisteredSubscription,
} from './event-subscriptions';

const Thing = defineEvent({
  type: 'alpha.thing-happened.v1',
  aggregateType: 'thing',
  payload: {
    thingId: eventField.id(),
    kind: eventField.enumOf(['small', 'large'] as const),
    at: eventField.instant(),
    count: eventField.integer(),
    flag: eventField.boolean(),
    tags: eventField.listOf(eventField.id()),
    previous: eventField.optional(eventField.id()),
  },
});

const ID = '0192f0c4-7f3e-7c2a-8b1d-2a9e4c6f8d10';

function named(name: string, type = Thing): RegisteredSubscription {
  return subscription({ name, event: type, handle: () => Promise.resolve() });
}

describe('SubscriptionRegistry (platform persistence design 6.4)', () => {
  it('registers a module its own subscriptions and lists the subscribers of a type, sorted', () => {
    const registry = new SubscriptionRegistry();
    registry.register('alpha', [named('alpha.second'), named('alpha.first')]);

    expect(registry.subscribersOf('alpha.thing-happened.v1')).toEqual([
      'alpha.first',
      'alpha.second',
    ]);
    expect(registry.subscribersOf('alpha.other-happened.v1')).toEqual([]);
    expect(registry.get('alpha.first')?.event.type).toBe('alpha.thing-happened.v1');
    expect(registry.names()).toEqual(['alpha.first', 'alpha.second']);
  });

  it.each(['beta.first', 'alpha', 'alpha.', 'Alpha.first', 'alpha.first.second', 'alpha.First'])(
    'refuses the name %p from module alpha',
    (name) => {
      expect(() => new SubscriptionRegistry().register('alpha', [named(name)])).toThrow(
        SubscriptionRegistryError,
      );
    },
  );

  it('refuses a name registered twice', () => {
    const registry = new SubscriptionRegistry();
    registry.register('alpha', [named('alpha.first')]);
    expect(() => registry.register('alpha', [named('alpha.first')])).toThrow(/twice/);
  });

  it('is sealed when the application has bootstrapped', () => {
    const registry = new SubscriptionRegistry();
    registry.onApplicationBootstrap();
    expect(registry.sealed).toBe(true);
    expect(() => registry.register('alpha', [named('alpha.first')])).toThrow(/sealed/);
  });
});

describe('decodePayload (P 6.4: the reverse of encodePayload)', () => {
  const stored = {
    thingId: ID,
    kind: 'small',
    at: '2026-10-08T01:02:03.004Z',
    count: 3,
    flag: false,
    tags: [ID],
    previous: null,
  };

  it('decodes every kind, instants back to Temporal.Instant', () => {
    const decoded = decodePayload(Thing.fields, stored);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toMatchObject({ thingId: ID, kind: 'small', count: 3, flag: false });
    expect(String(decoded.value['at'])).toBe('2026-10-08T01:02:03.004Z');
    expect(decoded.value['tags']).toEqual([ID]);
    expect(decoded.value['previous']).toBeNull();
    expect(Object.isFrozen(decoded.value)).toBe(true);
  });

  it.each([
    ['an undeclared key', { ...stored, extra: 1 }, null],
    ['a value outside the enum', { ...stored, kind: 'huge' }, 'kind'],
    ['a malformed id', { ...stored, thingId: 'nope' }, 'thingId'],
    ['a malformed instant', { ...stored, at: 'yesterday' }, 'at'],
    ['a fraction for an integer', { ...stored, count: 1.5 }, 'count'],
    ['a missing field', { ...stored, flag: undefined as unknown as boolean }, 'flag'],
    ['a bad list item', { ...stored, tags: [ID, 'nope'] }, 'tags'],
  ])('refuses %s, naming the field and never its value', (_case, payload, field) => {
    const clean = JSON.parse(JSON.stringify(payload)) as typeof stored;
    expect(decodePayload(Thing.fields, clean)).toEqual({
      ok: false,
      error: { code: 'event-payload.undecodable', field },
    });
  });
});

describe('back-off (P 6.4)', () => {
  it('is min(30 s x 2^(attempts - 1), 1 h)', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backOffSeconds)).toEqual([
      30, 60, 120, 240, 480, 960, 1920, 3600,
    ]);
    expect(backOffSeconds(MAX_DELIVERY_ATTEMPTS)).toBe(3600);
    expect(backOffSeconds(1000)).toBe(3600);
    expect(() => backOffSeconds(0)).toThrow(RangeError);
  });

  it('dead-letters after about three hours of attempts', () => {
    let total = 0;
    for (let attempts = 1; attempts < MAX_DELIVERY_ATTEMPTS; attempts += 1) {
      total += backOffSeconds(attempts);
    }
    expect(total / 3600).toBeGreaterThan(2.5);
    expect(total / 3600).toBeLessThan(4);
  });
});
