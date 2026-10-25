import {
  err,
  ok,
  type CallContext,
  type Clock,
  type IdGenerator,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PUSH_DEVICE_MANAGE } from '../../contracts/permissions';
import {
  parseExpoPushToken,
  registerPushDevice,
  type PushPlatform,
} from '../../domain/push-device';
import { ACCESS_DENIED, courierSessionOf, isSystem } from '../callers';
import { refusingBrokenRules, type NotificationsFailure } from '../failure';
import type { NotificationSettingsProvider, PushDeviceRepository } from '../ports';

export interface RegisterPushDeviceInput {
  readonly token: string;
  readonly platform: PushPlatform;
}

export interface RegisterPushDeviceDependencies {
  readonly devices: PushDeviceRepository;
  readonly settings: NotificationSettingsProvider;
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * The courier app registers the push device of its session, so that new offers reach the phone.
 * Rule `permissions [notifications.push-device.manage]`, couriers only. A session has one device:
 * registering again replaces it (a new token after a reinstall), and a token another session
 * held moves to this one. The device lives at most as long as a courier session can.
 */
export class RegisterPushDevice extends UseCase<
  RegisterPushDeviceInput,
  void,
  NotificationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.register-push-device',
    rule: { kind: 'permissions', allOf: [PUSH_DEVICE_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegisterPushDeviceDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: RegisterPushDeviceInput,
  ): Promise<Result<void, NotificationsFailure>> {
    const courier = courierSessionOf(context);
    if (courier === null) return Promise.resolve(err(ACCESS_DENIED));
    const token = parseExpoPushToken(input.token);
    if (token === undefined) {
      return Promise.resolve(
        err({ code: 'push-device.invalid-token', message: 'Not an Expo push token' }),
      );
    }
    const { devices, settings, unitOfWork, ids, clock } = this.deps;
    const { market } = context;
    const lifetime = settings.get(market.marketId).pushDeviceLifetimeSeconds;
    return unitOfWork.run(market, () =>
      refusingBrokenRules(async () => {
        const device = registerPushDevice(
          { id: ids.next<'PushDevice'>(), ...courier, platform: input.platform, token },
          clock.now(),
          lifetime,
        );
        await devices.save(market, device);
        return ok(undefined);
      }),
    );
  }
}

/**
 * The courier app drops the push device of its session on sign-out. Rule `permissions
 * [notifications.push-device.manage]`, couriers only. Dropping a device that is not there
 * changes nothing and answers the same.
 */
export class RemovePushDevice extends UseCase<Record<string, never>, void, NotificationsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.remove-push-device',
    rule: { kind: 'permissions', allOf: [PUSH_DEVICE_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: {
      readonly devices: PushDeviceRepository;
      readonly unitOfWork: UnitOfWork;
    },
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<void, NotificationsFailure>> {
    const courier = courierSessionOf(context);
    if (courier === null) return Promise.resolve(err(ACCESS_DENIED));
    const { market } = context;
    return this.deps.unitOfWork.run(market, async () => {
      await this.deps.devices.removeOfSession(market, courier.accountId, courier.sessionId);
      return ok(undefined);
    });
  }
}

/** One identity event that ended sessions of an account. */
export interface SessionsEndedInput {
  readonly delivery: EventDelivery;
  readonly accountId: string;
}

/**
 * Identity ended sessions of an account (disabled, password changed, other sessions signed
 * out): every push device of the account is dropped, so no phone of an ended session keeps
 * receiving offers. The app of a session that lives on registers again at its next start. Rule
 * `system`, from the `notifications.*-sessions` subscriptions; once per event.
 */
export class ForgetPushDevices extends UseCase<
  SessionsEndedInput,
  { readonly removed: number },
  NotificationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.forget-push-devices',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: {
      readonly devices: PushDeviceRepository;
      readonly unitOfWork: UnitOfWork;
    },
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SessionsEndedInput,
  ): Promise<Result<{ readonly removed: number }, NotificationsFailure>> {
    if (!isSystem(context)) return err(ACCESS_DENIED);
    const { market } = context;
    const done = await this.deps.unitOfWork.runOnce(market, input.delivery, async () =>
      ok(await this.deps.devices.removeOfAccount(market, input.accountId)),
    );
    if (!done.ok) return done;
    return ok({ removed: done.value.handled ? done.value.value : 0 });
  }
}
