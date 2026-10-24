import { Logger } from '@nestjs/common';
import { ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { TEST_MARKET_IDS, TEST_MARKETS } from '../../../test/support/test-config';
import type { MarketConfig } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import type { AccessDeclaration, PermissionKey } from './access-rule';
import { UseCase, UseCaseDefinitionError } from './use-case';
import { createUseCaseGate, UseCaseGate } from './use-case-gate';

// identity design 5.2: `execute` is the only public entry; it asks the gate, then `handle`.

const gate = () =>
  createUseCaseGate(
    new MarketRegistry(new Map(TEST_MARKET_IDS.map((id) => [id, {} as MarketConfig]))),
    null,
  );

class PurgeThings extends UseCase<{ readonly limit: number }, string> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.purge-things',
    rule: { kind: 'system' },
  };
  readonly seen: CallContext[] = [];

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly limit: number }) {
    this.seen.push(context);
    return Promise.resolve(ok(`purged ${input.limit} in ${context.market.marketId}`));
  }
}

class Lookup extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.lookup',
    rule: { kind: 'anonymous' },
  };
  constructor(gate: UseCaseGate) {
    super(gate);
  }
  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.actor.kind));
  }
}

describe.each(TEST_MARKETS)('UseCase in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnings.mockRestore();
  });

  it('runs handle with the admitted context when the gate admits', async () => {
    const useCase = new PurgeThings(gate());
    const context = testCallContext(market, 'system');

    await expect(useCase.execute(context, { limit: 5 })).resolves.toEqual({
      ok: true,
      value: `purged 5 in ${code}`,
    });
    expect(useCase.seen).toEqual([context]);
  });

  it('never runs handle when the gate refuses, and answers the refusal', async () => {
    const useCase = new PurgeThings(gate());

    await expect(
      useCase.execute(testCallContext(market, 'anonymous'), { limit: 5 }),
    ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(useCase.seen).toEqual([]);
  });

  it('hands handle the context the gate answered (the anonymous actor, HF9)', async () => {
    await expect(new Lookup(gate()).execute(testCallContext(market, 'anonymous'))).resolves.toEqual(
      { ok: true, value: 'anonymous' },
    );
  });
});

describe('UseCase construction refuses what the CI check also refuses (HF4)', () => {
  it('refuses a use case that extends another use case', () => {
    class Sneaky extends PurgeThings {
      static override readonly access: AccessDeclaration = {
        name: 'identity.sneaky',
        rule: { kind: 'system' },
      };
    }

    expect(() => new Sneaky(gate())).toThrow(UseCaseDefinitionError);
  });

  it('refuses a use case that overrides execute', () => {
    class Bypass extends UseCase<void, string> {
      static override readonly access: AccessDeclaration = {
        name: 'identity.bypass',
        rule: { kind: 'system' },
      };
      constructor(gate: UseCaseGate) {
        super(gate);
      }
      override execute(): Promise<Result<string, never>> {
        return Promise.resolve(ok('skipped the gate'));
      }
      protected handle(): Promise<Result<string, never>> {
        return Promise.resolve(ok('handled'));
      }
    }

    expect(() => new Bypass(gate())).toThrow(/execute/);
  });

  it('refuses a use case without its own valid declaration', () => {
    class Undeclared extends UseCase<void, string> {
      constructor(gate: UseCaseGate) {
        super(gate);
      }
      protected handle(): Promise<Result<string, never>> {
        return Promise.resolve(ok('handled'));
      }
    }
    class Malformed extends Undeclared {}
    Object.defineProperty(Undeclared, 'access', {
      // An unknown rule kind: no valid declaration.
      value: { name: 'identity.undeclared', rule: { kind: 'nobody' } },
    });

    expect(() => new Undeclared(gate())).toThrow(/declaration/);
    expect(() => new Malformed(gate())).toThrow(UseCaseDefinitionError);
  });

  it('refuses a gate that is not the platform UseCaseGate, a look-alike instance included (M1)', () => {
    const lenient = { admit: (_: unknown, context: CallContext) => Promise.resolve(ok(context)) };
    const lookalike = Object.assign(Object.create(UseCaseGate.prototype) as object, lenient);

    expect(() => new PurgeThings(lenient as unknown as UseCaseGate)).toThrow(/UseCaseGate/);
    expect(() => new PurgeThings(lookalike as UseCaseGate)).toThrow(/UseCaseGate/);
  });

  it('refuses a declaration given as an accessor', () => {
    class Computed extends UseCase<void, string> {
      static override get access(): AccessDeclaration {
        return { name: 'identity.computed', rule: { kind: 'system' } };
      }
      constructor(gate: UseCaseGate) {
        super(gate);
      }
      protected handle(): Promise<Result<string, never>> {
        return Promise.resolve(ok('handled'));
      }
    }

    expect(() => new Computed(gate())).toThrow(UseCaseDefinitionError);
  });
});

// Security review of slice 1c, H1: the body of handle is reachable only through execute.
describe.each(TEST_MARKETS)('UseCase keeps handle behind the gate in market %s (H1)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const anonymous = () => testCallContext(market, 'anonymous');
  const system = () => testCallContext(market, 'system');
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnings.mockRestore();
  });

  it('refuses a call of a handle the subclass made public', async () => {
    class PublicHandle extends UseCase<void, string> {
      static override readonly access: AccessDeclaration = {
        name: 'identity.public-handle',
        rule: { kind: 'system' },
      };
      constructor(gate: UseCaseGate) {
        super(gate);
      }
      override handle(context: CallContext): Promise<Result<string, never>> {
        return Promise.resolve(ok(`ran as ${context.actor.kind}`));
      }
    }
    const useCase = new PublicHandle(gate());

    expect(() => useCase.handle(anonymous())).toThrow(UseCaseDefinitionError);
    expect(() => PublicHandle.prototype.handle.call(useCase, anonymous())).toThrow(
      UseCaseDefinitionError,
    );
    await expect(useCase.execute(anonymous())).resolves.toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    await expect(useCase.execute(system())).resolves.toEqual({ ok: true, value: 'ran as system' });
  });

  it('refuses at construction a constructor that replaces execute', () => {
    class Reassigned extends UseCase<void, string> {
      static override readonly access: AccessDeclaration = {
        name: 'identity.reassigned',
        rule: { kind: 'system' },
      };
      constructor(gate: UseCaseGate) {
        super(gate);
        (this as { execute: unknown }).execute = (context: CallContext) => this.handle(context);
      }
      protected handle(context: CallContext): Promise<Result<string, never>> {
        return Promise.resolve(ok(`ran as ${context.actor.kind}`));
      }
    }

    expect(() => new Reassigned(gate())).toThrow(TypeError);
  });

  it('refuses at construction execute or handle as a class field', () => {
    class ExecuteField extends UseCase<void, string> {
      static override readonly access: AccessDeclaration = {
        name: 'identity.execute-field',
        rule: { kind: 'system' },
      };
      override readonly execute = () => Promise.resolve(ok('skipped the gate'));
      constructor(gate: UseCaseGate) {
        super(gate);
      }
      protected handle(): Promise<Result<string, never>> {
        return Promise.resolve(ok('handled'));
      }
    }
    class HandleField extends UseCase<void, string> {
      static override readonly access: AccessDeclaration = {
        name: 'identity.handle-field',
        rule: { kind: 'system' },
      };
      protected readonly handle = () => Promise.resolve(ok('handled'));
      constructor(gate: UseCaseGate) {
        super(gate);
      }
    }

    expect(() => new ExecuteField(gate())).toThrow(TypeError);
    expect(() => new HandleField(gate())).toThrow(UseCaseDefinitionError);
  });

  it('refuses a second public method that calls handle', async () => {
    class SecondEntry extends UseCase<void, string> {
      static override readonly access: AccessDeclaration = {
        name: 'identity.second-entry',
        rule: { kind: 'system' },
      };
      constructor(gate: UseCaseGate) {
        super(gate);
      }
      run(context: CallContext) {
        return this.handle(context);
      }
      protected handle(context: CallContext): Promise<Result<string, never>> {
        return Promise.resolve(ok(`ran as ${context.actor.kind}`));
      }
    }
    const useCase = new SecondEntry(gate());

    expect(() => useCase.run(anonymous())).toThrow(UseCaseDefinitionError);
    await expect(useCase.execute(system())).resolves.toEqual({ ok: true, value: 'ran as system' });
    // After execute, the window is closed again.
    expect(() => useCase.run(system())).toThrow(UseCaseDefinitionError);
  });

  it('runs an async body to its end, and handle stays closed while the body awaits', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    class Slow extends UseCase<void, string> {
      static override readonly access: AccessDeclaration = {
        name: 'identity.slow',
        rule: { kind: 'system' },
      };
      constructor(gate: UseCaseGate) {
        super(gate);
      }
      peek(context: CallContext) {
        return this.handle(context);
      }
      protected async handle(context: CallContext): Promise<Result<string, never>> {
        await released;
        return ok(`done in ${context.market.marketId}`);
      }
    }
    const useCase = new Slow(gate());

    const running = useCase.execute(system());
    await Promise.resolve();
    expect(() => useCase.peek(system())).toThrow(UseCaseDefinitionError);
    release();
    await expect(running).resolves.toEqual({ ok: true, value: `done in ${code}` });
  });
});

describe('UseCase freezes its declaration (L1)', () => {
  it('makes the static access non-writable and its rule immutable after construction', async () => {
    class Frozen extends UseCase<void, string> {
      static override readonly access: AccessDeclaration = {
        name: 'identity.frozen',
        rule: { kind: 'system' },
      };
      constructor(gate: UseCaseGate) {
        super(gate);
      }
      protected handle(): Promise<Result<string, never>> {
        return Promise.resolve(ok('handled'));
      }
    }
    const useCase = new Frozen(gate());
    const warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    expect(() => {
      (Frozen.access as { rule: unknown }).rule = { kind: 'anonymous' };
    }).toThrow(TypeError);
    expect(() => {
      (Frozen.access.rule as { kind: string }).kind = 'anonymous';
    }).toThrow(TypeError);
    expect(() => {
      (Frozen as { access: unknown }).access = {
        name: 'identity.frozen',
        rule: { kind: 'anonymous' },
      };
    }).toThrow(TypeError);
    expect(() =>
      Object.defineProperty(Frozen, 'access', {
        value: { name: 'x.y', rule: { kind: 'anonymous' } },
      }),
    ).toThrow(TypeError);
    await expect(
      useCase.execute(testCallContext(testMarketContext('AU', PLATFORM_TENANT_ID), 'anonymous')),
    ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    warnings.mockRestore();
  });

  it('freezes the key list of a permissions rule', () => {
    const allOf = ['identity.things.view'] as unknown as readonly [PermissionKey];
    class Keys extends UseCase<void, string> {
      static override readonly access: AccessDeclaration = {
        name: 'identity.keys',
        rule: { kind: 'permissions', allOf },
      };
      constructor(gate: UseCaseGate) {
        super(gate);
      }
      protected handle(): Promise<Result<string, never>> {
        return Promise.resolve(ok('handled'));
      }
    }
    new Keys(gate());

    expect(Object.isFrozen(allOf)).toBe(true);
    expect(() => (allOf as unknown as string[]).push('identity.things.edit')).toThrow(TypeError);
  });
});
