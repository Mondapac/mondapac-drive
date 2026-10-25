import { Temporal } from '@mondapac-drive/shared-kernel';
import type { SeedMailCatcher } from './mail-catcher';
import { SeedHttp, SeedRequestError } from './seed-http';
import { totpCode } from './totp';

/** One stop of a sample delivery, from the Market's seed data file. */
export interface SeedStop {
  readonly address: string;
  readonly postcode: string;
  readonly point: { readonly lat: number; readonly lng: number };
  readonly contactName: string;
  readonly contactPhone: string;
}

/**
 * A Market's seed data (`scripts/dev-seed/markets/<MARKET>.json`): everything Market-specific
 * the seed types into the API, so no Market value is written in code.
 */
export interface SeedData {
  readonly serviceAreaCode: string;
  readonly emailDomain: string;
  readonly merchantName: string;
  readonly pickup: SeedStop;
  readonly dropoffs: readonly SeedStop[];
  readonly vehicle: { readonly type: string; readonly plate: string; readonly coldBox: string };
}

/** One document requirement of the Market's fleet configuration (`fleet.documents`). */
export interface SeedDocumentRule {
  readonly type: string;
  readonly employmentTypes?: readonly string[];
  readonly vehicleTypes?: readonly string[];
  readonly coldChainOnly: boolean;
  readonly perVehicle: boolean;
  readonly expires: boolean;
}

/** A command of the operator runner, as the Market's SYSTEM actor; answers its JSON body. */
export type SeedOperator = (argv: readonly string[]) => Promise<{
  readonly exit: number;
  readonly body: Readonly<Record<string, unknown>>;
}>;

export interface SeedMarketInput {
  readonly baseUrl: string;
  readonly marketId: string;
  /** The admin panel's origin in this Market's (dev) configuration. */
  readonly adminOrigin: string;
  readonly data: SeedData;
  readonly documents: readonly SeedDocumentRule[];
  readonly mail: SeedMailCatcher;
  readonly operator: SeedOperator;
  /** The application clock, in epoch milliseconds (codes, document expiries). */
  readonly now: () => number;
  /** Booked deliveries left for dispatch to offer, besides the one assigned to the courier. */
  readonly samples: number;
  readonly password: string;
}

/** What the seed made: the credentials and ids a developer, the demo and the smoke run use. */
export interface SeedOutcome {
  readonly marketId: string;
  readonly admin: {
    readonly email: string;
    readonly password: string;
    readonly totpSecret: string;
    readonly recoveryCodes: readonly string[];
  };
  readonly merchant: { readonly merchantId: string; readonly apiKey: string };
  readonly courier: {
    readonly accountId: string;
    readonly fleetCourierId: string;
    readonly email: string;
    readonly password: string;
  };
  /** Assigned to the courier, for `pnpm --filter courier smoke` (SMOKE_DELIVERY_ID and _PIN). */
  readonly assignedDelivery: { readonly deliveryId: string; readonly pin: string };
  readonly sampleDeliveryIds: readonly string[];
}

/** The Market already has its first admin: the seed runs once per database. */
export class SeedAlreadyRunError extends Error {
  override readonly name = 'SeedAlreadyRunError';
}

const YEAR_MS = 365 * 24 * 3600 * 1000;
const PDF = new Uint8Array(Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'));

/**
 * Seeds one Market through the API (handoff 35): the first admin (operator routine, the
 * mailed invitation, an authenticator code, sign-in), a merchant with an API key, a courier
 * invited and accepted into an account, the courier's fleet profile, vehicle and documents
 * (verified and approved by the admin), one delivery booked by the merchant and assigned to the
 * courier (with its recipient PIN), and `samples` more deliveries waiting for dispatch.
 */
export async function seedMarket(input: SeedMarketInput): Promise<SeedOutcome> {
  const { data, marketId } = input;
  const http = new SeedHttp(input.baseUrl, marketId);
  const local = marketId.toLowerCase();
  const adminEmail = `admin.${local}@${data.emailDomain}`;
  const courierEmail = `courier.${local}@${data.emailDomain}`;
  const panel = { origin: input.adminOrigin, 'sec-fetch-site': 'same-origin' };

  // 1. The first admin: the operator routine, once the worker has seeded the Market's roles.
  for (let attempt = 0; ; attempt += 1) {
    const issued = await input.operator([
      'first-admin',
      '--market',
      marketId,
      '--email',
      adminEmail,
    ]);
    const outcome = String(issued.body.outcome);
    if (issued.exit === 0) break;
    if (outcome === 'first-admin.exists' || outcome === 'invitation.already-pending') {
      throw new SeedAlreadyRunError(
        `${marketId} already has its first admin (${outcome}): the seed runs once per database`,
      );
    }
    if (outcome !== 'roles.not-seeded' || attempt > 60) {
      throw new Error(`first-admin: ${outcome}`);
    }
    await pause(500);
  }
  const adminToken = await input.mail.linkTokenFor(adminEmail);
  const enrolment = await http.send<{ secret: string; tag: string; expiresAt: string }>(
    'POST',
    '/identity/admin/invitation/enrolment',
    panel,
    { token: adminToken },
  );
  const { secret } = enrolment.body;
  const accepted = await http.send<{ recoveryCodes: string[] }>(
    'POST',
    '/identity/admin/invitation/accept',
    panel,
    {
      token: adminToken,
      displayName: `Dev Admin ${marketId}`,
      password: input.password,
      secret,
      tag: enrolment.body.tag,
      expiresAt: enrolment.body.expiresAt,
      code: totpCode(secret, input.now()),
    },
  );
  const recoveryCodes = [...accepted.body.recoveryCodes];
  const admin = {
    ...panel,
    ...(await signInAdmin(http, panel, adminEmail, input, secret, recoveryCodes)),
  };

  // 2. A merchant with an API key (the marketplace's credential).
  const merchant = await http.send<{ merchantId: string }>(
    'POST',
    '/identity/admin/merchants',
    admin,
    { name: data.merchantName },
  );
  const { merchantId } = merchant.body;
  const key = await http.send<{ key: string }>(
    'POST',
    `/identity/admin/merchants/${merchantId}/api-keys`,
    admin,
    { label: 'Dev seed' },
  );
  const merchantHeaders = { authorization: `Bearer ${key.body.key}` };

  // 3. A courier: invited by the admin, accepted from the mailed link, signed in as the app does.
  await http.send('POST', '/identity/admin/couriers/invitations', admin, { email: courierEmail });
  const courierToken = await input.mail.linkTokenFor(courierEmail);
  await http.send(
    'POST',
    '/identity/courier/invitations/accept',
    {},
    {
      token: courierToken,
      displayName: `Dev Courier ${marketId}`,
      password: input.password,
    },
  );
  const session = await http.send<{ token: string }>(
    'POST',
    '/identity/courier/sign-in',
    {},
    {
      email: courierEmail,
      password: input.password,
    },
  );
  const courier = { authorization: `Bearer ${session.body.token}` };
  const accountId = await courierAccountId(http, admin, courierEmail);

  // 4. The fleet profile, a vehicle and every document the Market asks of it, verified.
  const profile = await http.send<{ id: string }>('POST', '/fleet/courier/me', courier, {
    employmentType: 'contractor',
    serviceAreaCode: data.serviceAreaCode,
    coldChainCapable: true,
  });
  const fleetCourierId = profile.body.id;
  const withVehicle = await http.send<{ vehicles: { id: string }[] }>(
    'POST',
    '/fleet/courier/me/vehicles',
    courier,
    data.vehicle,
  );
  const vehicleId = withVehicle.body.vehicles[0]!.id;
  const expiresAt = Temporal.Instant.fromEpochMilliseconds(input.now() + YEAR_MS).toString();
  for (const rule of input.documents) {
    if (!documentApplies(rule, data.vehicle.type)) continue;
    const form = new FormData();
    form.set('type', rule.type);
    if (rule.perVehicle) form.set('vehicleId', vehicleId);
    if (rule.expires) form.set('expiresAt', expiresAt);
    form.set('file', new Blob([PDF], { type: 'application/pdf' }), 'scan.pdf');
    await http.send('POST', '/fleet/courier/me/documents', courier, form);
  }
  const base = `/fleet/admin/couriers/${fleetCourierId}`;
  const detail = await http.send<{ documents: { id: string; expiresAt: string | null }[] }>(
    'GET',
    base,
    admin,
  );
  for (const document of detail.body.documents) {
    await http.send(
      'POST',
      `${base}/documents/${document.id}/verify`,
      admin,
      document.expiresAt === null ? {} : { expiresAt: document.expiresAt },
    );
  }
  await http.send('POST', `${base}/approve`, admin, {
    employmentType: 'contractor',
    coldChainCapable: true,
  });
  await http.send('PUT', `${base}/tax-registration`, admin, { taxRegistered: true });
  // Proves the courier can go online, then leaves them offline for the developer or smoke run.
  await http.send('PUT', '/fleet/courier/me/shift', courier, { state: 'online' });
  await http.send('PUT', '/fleet/courier/me/shift', courier, { state: 'offline' });
  await http.send('POST', '/identity/courier/sign-out', courier, {});

  // 5. One delivery assigned to the courier (with its PIN), and samples left for dispatch.
  const book = async (index: number, temperature: 'ambient' | 'chilled') => {
    const dropoff = data.dropoffs[index % data.dropoffs.length]!;
    const booked = await http.send<{ id: string; quote: { vehicle: string } }>(
      'POST',
      '/delivery/deliveries',
      merchantHeaders,
      {
        externalReference: `dev-seed-${local}-${input.now()}-${index}`,
        pickup: data.pickup,
        dropoff,
        parcel: { weightGrams: 2000, volumeLitres: 10, temperature },
        mode: 'on_demand',
      },
    );
    return booked.body;
  };
  const assigned = await book(0, 'ambient');
  await retryWhile(
    () =>
      http.send('POST', `/dispatch/admin/deliveries/${assigned.id}/assign`, admin, {
        courierId: accountId,
        vehicle: assigned.quote.vehicle,
      }),
    // Dispatch opens its job from delivery.booked through the worker loop.
    (error) => error instanceof SeedRequestError && error.status === 404,
  );
  // Delivery takes the assignment from dispatch's event through the worker loop: wait for it,
  // so the courier's job route answers before this process (and its loop) ends.
  await retryWhile(
    async () => {
      const view = await http.send<{ status: string }>(
        'GET',
        `/delivery/admin/deliveries/${assigned.id}`,
        admin,
      );
      if (view.body.status !== 'ASSIGNED') throw new NotYetError();
    },
    (error) => error instanceof NotYetError,
  );
  const pin = await input.operator([
    'delivery-pin',
    '--market',
    marketId,
    '--delivery',
    assigned.id,
  ]);
  if (pin.exit !== 0 || typeof pin.body.pin !== 'string') {
    throw new Error(`delivery-pin: ${String(pin.body.outcome)}`);
  }
  const sampleDeliveryIds: string[] = [];
  for (let index = 1; index <= input.samples; index += 1) {
    sampleDeliveryIds.push((await book(index, index % 2 === 1 ? 'chilled' : 'ambient')).id);
  }

  return {
    marketId,
    admin: { email: adminEmail, password: input.password, totpSecret: secret, recoveryCodes },
    merchant: { merchantId, apiKey: key.body.key },
    courier: { accountId, fleetCourierId, email: courierEmail, password: input.password },
    assignedDelivery: { deliveryId: assigned.id, pin: pin.body.pin },
    sampleDeliveryIds,
  };
}

/**
 * The admin's password and code steps. The code is the next time step's (identity accepts one
 * step of drift), because the acceptance just used the current one; a recovery code if refused.
 */
async function signInAdmin(
  http: SeedHttp,
  panel: Readonly<Record<string, string>>,
  email: string,
  input: SeedMarketInput,
  secret: string,
  recoveryCodes: string[],
): Promise<Record<string, string>> {
  const step = await http.send<{ code: string; challengeToken: string }>(
    'POST',
    '/identity/admin/sign-in',
    panel,
    { email, password: input.password },
  );
  if (step.body.code !== 'second-factor-required') throw new Error(`sign-in: ${step.body.code}`);
  let signedIn;
  try {
    signedIn = await http.send<{ csrfToken: string }>(
      'POST',
      '/identity/admin/second-factor',
      panel,
      {
        challengeToken: step.body.challengeToken,
        code: totpCode(secret, input.now() + 30_000),
      },
    );
  } catch (error) {
    if (!(error instanceof SeedRequestError) || error.status !== 400) throw error;
    signedIn = await http.send<{ csrfToken: string }>(
      'POST',
      '/identity/admin/second-factor',
      panel,
      {
        challengeToken: step.body.challengeToken,
        code: recoveryCodes.shift()!,
      },
    );
  }
  const cookie = signedIn.headers.getSetCookie().find((line) => line.includes('session-admin'));
  if (cookie === undefined) throw new Error('second-factor: no session cookie');
  return { cookie: cookie.split(';')[0]!, 'x-csrf-token': signedIn.body.csrfToken };
}

/** The courier's identity account id (dispatch assigns by it), from the admin's courier list. */
async function courierAccountId(
  http: SeedHttp,
  admin: Readonly<Record<string, string>>,
  email: string,
): Promise<string> {
  const list = await http.send<{ items: { accountId: string; email: string }[] }>(
    'GET',
    '/identity/admin/couriers?limit=100',
    admin,
  );
  const found = list.body.items.find((item) => item.email.toLowerCase() === email.toLowerCase());
  if (found === undefined) throw new Error('the accepted courier is not in the courier list');
  return found.accountId;
}

/** Whether a contractor with cold-chain capability and this vehicle needs the document. */
export function documentApplies(rule: SeedDocumentRule, vehicleType: string): boolean {
  if (rule.employmentTypes !== undefined && !rule.employmentTypes.includes('contractor')) {
    return false;
  }
  return rule.vehicleTypes === undefined || rule.vehicleTypes.includes(vehicleType);
}

class NotYetError extends Error {}

async function retryWhile<T>(
  call: () => Promise<T>,
  retryable: (error: unknown) => boolean,
  attempts = 60,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts || !retryable(error)) throw error;
      await pause(500);
    }
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
