import { defineEvent, eventField } from '@mondapac-drive/shared-kernel';
import type { EventDescription } from '@mondapac-drive/shared-kernel';
import {
  compareWithSnapshot,
  EventCatalogue,
  EventCatalogueError,
  registerEvents,
} from './event-catalogue';

const registered = defineEvent({
  type: 'identity.account-registered.v1',
  aggregateType: 'account',
  payload: { accountId: eventField.id() },
});
const disabled = defineEvent({
  type: 'identity.account-disabled.v1',
  aggregateType: 'account',
  payload: { accountId: eventField.id(), cause: eventField.enumOf(['admin', 'erasure'] as const) },
});
const sellerApproved = defineEvent({
  type: 'sellers.seller-approved.v1',
  aggregateType: 'seller',
  payload: { sellerId: eventField.id() },
});

describe('EventCatalogue (platform persistence design 5.3)', () => {
  it('holds the definitions a module registers, by type', () => {
    const catalogue = new EventCatalogue();
    catalogue.register('identity', [registered, disabled]);
    catalogue.register('sellers', [sellerApproved]);

    expect(catalogue.get('identity.account-registered.v1')).toBe(registered);
    expect(catalogue.get('sellers.seller-approved.v1')).toBe(sellerApproved);
    expect(catalogue.get('identity.account-registered.v2')).toBeUndefined();
  });

  it('fails boot on a duplicate type, also across two registrations', () => {
    const catalogue = new EventCatalogue();
    catalogue.register('identity', [registered]);

    expect(() => catalogue.register('identity', [registered])).toThrow(EventCatalogueError);
    expect(() => new EventCatalogue().register('identity', [disabled, disabled])).toThrow(
      /registered twice/,
    );
  });

  it("fails boot on a type whose first segment is not the registering module's", () => {
    expect(() => new EventCatalogue().register('identity', [sellerApproved])).toThrow(
      /a type starts with its module/,
    );
  });

  it('is sealed when the application has bootstrapped: no registration after that', () => {
    const catalogue = new EventCatalogue();
    catalogue.register('identity', [registered]);
    catalogue.onApplicationBootstrap();

    expect(catalogue.sealed).toBe(true);
    expect(() => catalogue.register('identity', [disabled])).toThrow(/sealed/);
    expect(catalogue.get(registered.type)).toBe(registered);
  });

  it('describes every type and its fields, sorted by type', () => {
    const catalogue = new EventCatalogue();
    catalogue.register('sellers', [sellerApproved]);
    catalogue.register('identity', [registered, disabled]);

    expect(catalogue.snapshot()).toEqual([
      {
        type: 'identity.account-disabled.v1',
        aggregateType: 'account',
        fields: { accountId: 'id', cause: 'enumOf(admin|erasure)' },
      },
      {
        type: 'identity.account-registered.v1',
        aggregateType: 'account',
        fields: { accountId: 'id' },
      },
      {
        type: 'sellers.seller-approved.v1',
        aggregateType: 'seller',
        fields: { sellerId: 'id' },
      },
    ]);
  });

  it('registers through the one provider line a module adds', () => {
    const catalogue = new EventCatalogue();
    const provider = registerEvents('identity', [registered]) as {
      inject: unknown[];
      useFactory: (catalogue: EventCatalogue) => unknown;
    };

    expect(provider.inject).toEqual([EventCatalogue]);
    provider.useFactory(catalogue);
    expect(catalogue.get(registered.type)).toBe(registered);
  });
});

describe('compareWithSnapshot (the contracts test of 5.3)', () => {
  const entry = (fields: Record<string, string>, aggregateType = 'account'): EventDescription => ({
    type: 'identity.account-registered.v1',
    aggregateType,
    fields,
  });

  it('accepts the same catalogue, whatever the field order', () => {
    expect(
      compareWithSnapshot(
        [entry({ accountId: 'id', sellerId: 'optional(id)' })],
        [entry({ sellerId: 'optional(id)', accountId: 'id' })],
      ),
    ).toEqual([]);
  });

  it('fails on a new type until the snapshot changes', () => {
    expect(compareWithSnapshot([entry({ accountId: 'id' })], [])).toEqual([
      'identity.account-registered.v1 is new: add it to the snapshot, for security review',
    ]);
  });

  it.each([
    ['an added field', { accountId: 'id', note: 'id' }, 'account'],
    ['a removed field', {}, 'account'],
    ['a changed kind', { accountId: 'optional(id)' }, 'account'],
    ['another aggregate type', { accountId: 'id' }, 'seller'],
  ])('fails with "publish a new version" on %s of an existing type', (_case, fields, aggregate) => {
    expect(compareWithSnapshot([entry(fields, aggregate)], [entry({ accountId: 'id' })])).toEqual([
      'identity.account-registered.v1 changed its aggregate type or fields: publish a new version instead',
    ]);
  });

  it('fails on a type that is in the snapshot but no longer registered', () => {
    expect(compareWithSnapshot([], [entry({ accountId: 'id' })])).toEqual([
      'identity.account-registered.v1 is in the snapshot but not registered',
    ]);
  });
});
