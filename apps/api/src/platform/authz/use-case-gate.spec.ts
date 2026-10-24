import { Logger } from '@nestjs/common';
import { isMinted, parseId } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac-drive/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { TEST_MARKET_IDS, TEST_MARKETS, testMarketId } from '../../../test/support/test-config';
import type { MarketConfig } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import type { AccessDeclaration, PermissionKey } from './access-rule';
import type { AccessDecision, AuthorisationCheck } from './authorisation-check';
import { createUseCaseGate, isUseCaseGate, UseCaseGate } from './use-case-gate';

// identity design 5.2 ("Wrapper"), 5.1 (anonymous, HF9), HF4; foundations 6.2 to 6.4.

const registryHosting = (codes: readonly string[]) =>
  new MarketRegistry(new Map(codes.map((code) => [testMarketId(code), {} as MarketConfig])));

const id = <K extends string>(text: string): Id<K> => {
  const parsed = parseId<K>(text);
  if (!parsed.ok) throw new Error('test setup: bad id');
  return parsed.value;
};
const ACCOUNT = id<'Account'>('01890a5d-ac96-774b-bcce-b302099a8057');
const SESSION = id<'Session'>('01890a5d-ac96-774b-bcce-b302099a8058');
const MERCHANT = id<'Merchant'>('01890a5d-ac96-774b-bcce-b302099a8059');
const KEY = 'identity.merchant.view' as PermissionKey;

/** A use-case class with its own declaration: the gate reads only `access`. */
function useCaseWith(access: unknown): abstract new () => unknown {
  const useCase = class {};
  Object.defineProperty(useCase, 'access', { value: access, enumerable: true });
  return useCase;
}

const SYSTEM_ONLY = useCaseWith({ name: 'identity.purge-expired', rule: { kind: 'system' } });
const ANONYMOUS = useCaseWith({ name: 'identity.sign-in', rule: { kind: 'anonymous' } });
const OWN = useCaseWith({
  name: 'identity.change-password',
  rule: { kind: 'own-resources' },
});
const PERMISSIONS = useCaseWith({
  name: 'identity.list-merchants',
  rule: { kind: 'permissions', allOf: [KEY] },
});

class RecordingCheck implements AuthorisationCheck {
  readonly calls: { context: CallContext; declaration: AccessDeclaration }[] = [];
  constructor(private readonly answer: () => Promise<AccessDecision>) {}
  check(context: CallContext, declaration: AccessDeclaration): Promise<AccessDecision> {
    this.calls.push({ context, declaration });
    return this.answer();
  }
}

const ALLOW = () => Promise.resolve<AccessDecision>({ allowed: true });

describe.each(TEST_MARKETS)('UseCaseGate in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, PLATFORM_TENANT_ID);
  const authenticated = (population: 'admin' | 'merchant' | 'courier' = 'admin') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ACCOUNT,
        sessionId: SESSION,
        merchantId: population === 'merchant' ? MERCHANT : null,
      }),
    );
  let warnings: jest.SpyInstance;
  let errors: jest.SpyInstance;

  beforeEach(() => {
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnings.mockRestore();
    errors.mockRestore();
  });

  const gateWith = (check: AuthorisationCheck | null = new RecordingCheck(ALLOW)) =>
    createUseCaseGate(registryHosting(TEST_MARKET_IDS), check);

  describe('the system rule', () => {
    it('admits the system actor, with the very context it received', async () => {
      const context = testCallContext(market, 'system');

      await expect(gateWith().admit(SYSTEM_ONLY, context)).resolves.toEqual({
        ok: true,
        value: context,
      });
    });

    it.each(['anonymous', 'authenticated'] as const)(
      'refuses the %s actor with access.denied',
      async (kind) => {
        const context = kind === 'anonymous' ? testCallContext(market, kind) : authenticated();

        await expect(gateWith().admit(SYSTEM_ONLY, context)).resolves.toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
      },
    );
  });

  describe('the anonymous rule (5.1, HF9)', () => {
    it('admits the anonymous actor unchanged', async () => {
      const context = testCallContext(market, 'anonymous');

      await expect(gateWith().admit(ANONYMOUS, context)).resolves.toEqual({
        ok: true,
        value: context,
      });
    });

    it.each(['admin', 'merchant', 'courier'] as const)(
      "admits a signed-in %s but hands the use case the Market's anonymous actor",
      async (population) => {
        const check = new RecordingCheck(ALLOW);
        const context = authenticated(population);

        const result = await gateWith(check).admit(ANONYMOUS, context);

        if (!result.ok) throw new Error('expected admission');
        expect(result.value).not.toBe(context);
        expect(isMinted(result.value)).toBe(true);
        expect(result.value.actor).toEqual({ kind: 'anonymous', marketId: code });
        expect(result.value.market).toBe(market);
        expect(result.value.correlationId).toBe(context.correlationId);
        expect(check.calls).toEqual([]);
      },
    );

    it('never admits the system actor', async () => {
      await expect(gateWith().admit(ANONYMOUS, testCallContext(market, 'system'))).resolves.toEqual(
        { ok: false, error: { code: 'access.denied' } },
      );
    });
  });

  describe.each([
    ['own-resources', OWN],
    ['permissions', PERMISSIONS],
  ])('the %s rule', (_kind, useCase) => {
    it('refuses the anonymous actor with access.unauthenticated, without asking the check', async () => {
      const check = new RecordingCheck(ALLOW);

      await expect(
        gateWith(check).admit(useCase, testCallContext(market, 'anonymous')),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unauthenticated' } });
      expect(check.calls).toEqual([]);
    });

    it('refuses the system actor with access.denied', async () => {
      await expect(gateWith().admit(useCase, testCallContext(market, 'system'))).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('asks the check for an authenticated actor, with the context and the declaration', async () => {
      const check = new RecordingCheck(ALLOW);
      const context = authenticated();

      await expect(gateWith(check).admit(useCase, context)).resolves.toEqual({
        ok: true,
        value: context,
      });
      expect(check.calls).toEqual([
        { context, declaration: (useCase as unknown as { access: AccessDeclaration }).access },
      ]);
    });

    it.each<[string, AccessDecision]>([
      ['access.denied', { allowed: false, denial: { code: 'access.denied' } }],
      ['access.unavailable', { allowed: false, denial: { code: 'access.unavailable' } }],
    ])("passes on the check's %s", async (_code, decision) => {
      const result = await gateWith(new RecordingCheck(() => Promise.resolve(decision))).admit(
        useCase,
        authenticated('merchant'),
      );

      expect(result).toEqual({ ok: false, error: decision.allowed ? null : decision.denial });
    });

    it.each<[string, () => Promise<AccessDecision>]>([
      ['throws', () => Promise.reject(new Error('database down'))],
      ['answers something else', () => Promise.resolve({ allowed: 'yes' } as never)],
      [
        'answers access.unauthenticated',
        () =>
          Promise.resolve({ allowed: false, denial: { code: 'access.unauthenticated' } } as never),
      ],
      [
        "answers the marketplace's seller-state denial",
        () =>
          Promise.resolve({
            allowed: false,
            denial: { code: 'access.seller-not-approved', details: { state: 'approved' } },
          } as never),
      ],
    ])('fails closed with access.unavailable when the check %s', async (_case, answer) => {
      await expect(
        gateWith(new RecordingCheck(answer)).admit(useCase, authenticated()),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unavailable' } });
    });

    it('fails closed with access.unavailable while no check is bound (before identity slice 2)', async () => {
      await expect(gateWith(null).admit(useCase, authenticated())).resolves.toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
    });
  });

  describe('before any rule is decided', () => {
    it('reads the declaration only as an own property: a subclass never inherits it (HF4)', async () => {
      const Parent = useCaseWith({ name: 'identity.parent', rule: { kind: 'system' } });
      class Child extends (Parent as unknown as new () => object) {}

      await expect(gateWith().admit(Child, testCallContext(market, 'system'))).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it.each<[string, unknown]>([
      ['no declaration', undefined],
      ['an unknown rule kind', { name: 'identity.x', rule: { kind: 'any-of' } }],
      ['an empty allOf', { name: 'identity.x', rule: { kind: 'permissions', allOf: [] } }],
      ['a malformed key', { name: 'identity.x', rule: { kind: 'permissions', allOf: ['Admin'] } }],
      [
        "the marketplace's seller-state attribute",
        { name: 'identity.x', rule: { kind: 'system' }, whenSellerNotApproved: 'deny' },
      ],
      ['an extra field', { name: 'identity.x', rule: { kind: 'system' }, bypass: true }],
      ['a malformed name', { name: 'Identity X', rule: { kind: 'system' } }],
    ])('refuses %s with access.denied', async (_case, access) => {
      await expect(
        gateWith().admit(useCaseWith(access), testCallContext(market, 'system')),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    });

    it('refuses a context that was not minted, whatever the rule', async () => {
      const minted = testCallContext(market, 'system');
      for (const forged of [{ ...minted }, JSON.parse(JSON.stringify(minted)) as unknown]) {
        await expect(gateWith().admit(SYSTEM_ONLY, forged as CallContext)).resolves.toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
        await expect(gateWith().admit(ANONYMOUS, forged as CallContext)).resolves.toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
    });

    it('refuses a Market this Region Stack does not host (W2)', async () => {
      const others = TEST_MARKETS.filter((other) => other !== code);
      const gate = createUseCaseGate(registryHosting(others), new RecordingCheck(ALLOW));

      await expect(gate.admit(SYSTEM_ONLY, testCallContext(market, 'system'))).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('turns an exception inside the gate into access.unavailable', async () => {
      const broken = new MarketRegistry(new Map());
      jest.spyOn(broken, 'isHosted').mockImplementation(() => {
        throw new Error('boom');
      });

      await expect(
        createUseCaseGate(broken, null).admit(SYSTEM_ONLY, testCallContext(market, 'system')),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unavailable' } });
    });
  });

  describe('logging (5.2: every denial with use case, rule, actor id and correlation id)', () => {
    it('logs a denial with those fields and nothing of the input', async () => {
      const context = authenticated();

      await gateWith(
        new RecordingCheck(() =>
          Promise.resolve({ allowed: false, denial: { code: 'access.denied' } }),
        ),
      ).admit(PERMISSIONS, context);

      expect(warnings).toHaveBeenCalledWith({
        msg: 'access.denied',
        useCase: 'identity.list-merchants',
        rule: 'permissions',
        keys: [KEY],
        actor: 'authenticated',
        actorId: ACCOUNT,
        marketId: code,
        correlationId: context.correlationId,
        reason: 'check-denied',
        code: 'access.denied',
      });
    });

    it('logs a denial of an unknown use case without reading its parts', async () => {
      await gateWith().admit(useCaseWith(undefined), testCallContext(market, 'system'));

      expect(warnings).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'access.denied',
          useCase: null,
          reason: 'declaration-missing',
          actor: 'system',
          actorId: null,
        }),
      );
    });

    it('logs no line when it admits', async () => {
      await gateWith().admit(SYSTEM_ONLY, testCallContext(market, 'system'));

      expect(warnings).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    });
  });
});

describe('UseCaseGate is final and minted (M1)', () => {
  it('cannot be subclassed: a subclass could replace the decision', () => {
    class Lenient extends UseCaseGate {}

    expect(
      () => new Lenient(Symbol('forged') as never, registryHosting(TEST_MARKET_IDS), null),
    ).toThrow(TypeError);
  });

  it("cannot be built without the private key, even from a real gate's constructor", () => {
    const real = createUseCaseGate(registryHosting(TEST_MARKET_IDS), null);
    const Gate = real.constructor as new (...args: unknown[]) => UseCaseGate;

    expect(() => new Gate(Symbol('UseCaseGate.construction'), registryHosting([]), null)).toThrow(
      /built by platform\/authz/,
    );
    expect(() => new Gate(undefined, registryHosting([]), null)).toThrow(TypeError);
  });

  it('recognises only the gates its factory built', () => {
    const real = createUseCaseGate(registryHosting(TEST_MARKET_IDS), null);
    const lookalike = Object.create(UseCaseGate.prototype) as unknown;

    expect(isUseCaseGate(real)).toBe(true);
    expect(isUseCaseGate(lookalike)).toBe(false);
    expect(isUseCaseGate({ admit: () => undefined })).toBe(false);
    expect(isUseCaseGate(null)).toBe(false);
  });
});
