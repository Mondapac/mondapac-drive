import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import type { AccessDenied } from './access-denied';
import { accessDeclarationOf, type AccessDeclaration } from './access-rule';
import { isUseCaseGate, type UseCaseGate } from './use-case-gate';

/** A use-case class that breaks the rules of identity design 5.2 (HF4): refused at boot. */
export class UseCaseDefinitionError extends Error {
  override readonly name = 'UseCaseDefinitionError';
}

type Body = (this: object, context: CallContext, input: never) => unknown;

/**
 * The original `handle` of each use-case class, taken from its prototype at its first
 * construction. The prototype's `handle` is then replaced by one that always throws, so the
 * body is reachable only through `execute` (security review of slice 1c, H1).
 */
const bodies = new WeakMap<object, Body>();

const NOT_THROUGH_EXECUTE = (name: string): UseCaseDefinitionError =>
  new UseCaseDefinitionError(`${name}.handle runs only through execute, behind the gate`);

/** Takes the body of `handle` from the class's prototype once, and seals the prototype. */
function bodyOf(useCase: { readonly name: string; readonly prototype: object }): Body {
  const known = bodies.get(useCase);
  if (known !== undefined) return known;
  const descriptor = Object.getOwnPropertyDescriptor(useCase.prototype, 'handle');
  if (descriptor === undefined || typeof descriptor.value !== 'function') {
    throw new UseCaseDefinitionError(`${useCase.name} must declare handle as a method`);
  }
  const body = descriptor.value as Body;
  const name = useCase.name;
  Object.defineProperty(useCase.prototype, 'handle', {
    value: function handle(): never {
      throw NOT_THROUGH_EXECUTE(name);
    },
    writable: false,
    configurable: false,
    enumerable: false,
  });
  bodies.set(useCase, body);
  return body;
}

/**
 * Freezes the declaration, deeply, and makes the class's `access` non-writable and
 * non-configurable: the rule the gate reads cannot change after boot (security review of slice
 * 1c, L1).
 */
function sealDeclaration(useCase: object, declaration: AccessDeclaration): void {
  const { rule } = declaration;
  if (rule.kind === 'permissions') Object.freeze(rule.allOf);
  Object.freeze(rule);
  Object.freeze(declaration);
  const descriptor = Object.getOwnPropertyDescriptor(useCase, 'access');
  if (descriptor?.configurable === true) {
    Object.defineProperty(useCase, 'access', {
      value: declaration,
      writable: false,
      configurable: false,
      enumerable: descriptor.enumerable ?? false,
    });
  }
}

/**
 * The base class of every use case (identity design 5.2; platform-foundations design 6.4). A
 * use case is a class in `modules/<m>/application/use-cases/<name>.use-case.ts` that extends
 * this class directly and carries its rule as an own static property:
 *
 * ```ts
 * export class PurgeExpired extends UseCase<PurgeInput, PurgeOutput> {
 *   static override readonly access: AccessDeclaration = {
 *     name: 'identity.purge-expired',
 *     rule: { kind: 'system' },
 *   };
 *   constructor(gate: UseCaseGate, private readonly sessions: SessionRepository) {
 *     super(gate);
 *   }
 *   protected async handle(context: CallContext, input: PurgeInput) { ... }
 * }
 * ```
 *
 * The module's provider injects `USE_CASE_GATE`; a module imports all of this from the
 * `platform/authz` barrel. `execute` is the only entry: it asks the gate and only then runs the
 * body of `handle`, which checks ownership (R6) and opens its own unit of work (platform
 * persistence 3.4).
 *
 * The constructor refuses, so boot fails, a class that does not extend `UseCase` directly,
 * overrides `execute`, has no valid declaration of its own (a value, not an accessor), or has
 * no `handle` method. It then closes every other way to the body (H1): the prototype's
 * `handle` always throws; the instance gets an own, non-writable, non-configurable `handle`
 * that runs the body only while `execute` is calling it, and an own, non-writable,
 * non-configurable `execute`, so neither can be replaced by an assignment or a class field.
 * The declaration is frozen (L1). The CI check refuses the same in source, and the gate checks
 * the declaration again on every call.
 */
export abstract class UseCase<Input, Output, Failure = never> {
  /** Declared by every concrete subclass as its own property; never inherited (HF4). */
  declare static readonly access: AccessDeclaration;

  readonly #gate: UseCaseGate;
  /** The concrete class, captured at construction: the gate reads its own `access`. */
  readonly #useCase: object;
  readonly #body: Body;
  /** True only during the synchronous call of the body by `execute`. */
  #admitting = false;

  protected constructor(gate: UseCaseGate) {
    if (!isUseCaseGate(gate)) {
      throw new UseCaseDefinitionError('A use case is constructed with the platform UseCaseGate');
    }
    const useCase = new.target;
    if (Object.getPrototypeOf(useCase) !== UseCase) {
      throw new UseCaseDefinitionError(
        `${useCase.name} must extend UseCase directly; a use case never extends another one`,
      );
    }
    if (Object.hasOwn(useCase.prototype, 'execute')) {
      throw new UseCaseDefinitionError(`${useCase.name} overrides execute, the gate's entry`);
    }
    if (!('value' in (Object.getOwnPropertyDescriptor(useCase, 'access') ?? {}))) {
      throw new UseCaseDefinitionError(`${useCase.name} has no access declaration of its own`);
    }
    const declared = accessDeclarationOf(useCase);
    if (!declared.ok) {
      throw new UseCaseDefinitionError(
        `${useCase.name} has no valid access declaration of its own (${declared.error.code})`,
      );
    }
    sealDeclaration(useCase, declared.value);
    const body = bodyOf(useCase);
    this.#gate = gate;
    this.#useCase = useCase;
    this.#body = body;

    const name = useCase.name;
    Object.defineProperty(this, 'handle', {
      value: (...args: [CallContext, never]): unknown => {
        if (!this.#admitting) throw NOT_THROUGH_EXECUTE(name);
        return body.apply(this, args);
      },
      writable: false,
      configurable: false,
      enumerable: false,
    });
    // The gate's entry pinned on the instance: it runs the prototype's `execute` on the
    // receiver of the call, exactly as the prototype method would.
    Object.defineProperty(this, 'execute', {
      value: function execute(
        this: UseCase<Input, Output, Failure>,
        ...args: [CallContext, Input]
      ): Promise<Result<Output, AccessDenied | Failure>> {
        return UseCase.prototype.execute.apply(this, args);
      },
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }

  /** The only public entry: the gate first, then the body with the context it admitted. */
  async execute(
    context: CallContext,
    input: Input,
  ): Promise<Result<Output, AccessDenied | Failure>> {
    const admitted = await this.#gate.admit(this.#useCase, context);
    if (!admitted.ok) return admitted;
    let running: Promise<Result<Output, Failure>>;
    this.#admitting = true;
    try {
      running = this.#body.call(this, admitted.value, input as never) as Promise<
        Result<Output, Failure>
      >;
    } finally {
      this.#admitting = false;
    }
    return running;
  }

  /**
   * The body. Run by `execute` only, after admission, with the admitted context: under an
   * `anonymous` rule its actor is always the Market's anonymous actor (HF9). Calling it in any
   * other way throws `UseCaseDefinitionError`.
   */
  protected abstract handle(context: CallContext, input: Input): Promise<Result<Output, Failure>>;
}
