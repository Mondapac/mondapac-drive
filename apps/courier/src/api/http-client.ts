import type { z } from 'zod';
import {
  ApiError,
  type ActiveJobMemory,
  type CourierApi,
  type JobEvent,
  type PhotoFile,
  type SessionSource,
  type DocumentUpload,
} from './client';
import {
  apiError,
  courierSession,
  courierSignedIn,
  courierSettings,
  courierStatus,
  currentOffer,
  earningsBalance,
  earningsSummary,
  job,
  offerAccepted,
  proofPhoto,
  type CourierStatus,
  type Job,
  courierMe,
  documentSubmitted,
  courierProfile,
  onboardingRules,
  payoutOnboardingLink,
} from './schemas';

/** Statuses after which the courier has nothing left to do on a delivery. */
const FINISHED: ReadonlySet<Job['status']> = new Set([
  'DELIVERED',
  'DELIVERY_FAILED',
  'RETURNING',
  'RETURNED',
  'CANCELLED',
]);

/** An id as the API issues it; anything else (such as `..`) never reaches a path. */
function segment(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ApiError(400, 'id.invalid');
  return id;
}

/** The routes the app calls, in one place: identity, fleet, dispatch, delivery, tracking, payouts. */
export const ROUTES = {
  signIn: '/identity/courier/sign-in',
  signOut: '/identity/courier/sign-out',
  settings: '/fleet/courier/me/settings',
  status: '/fleet/courier/me',
  shift: '/fleet/courier/me/shift',
  currentOffer: '/dispatch/courier/offers/current',
  acceptOffer: (id: string) => `/dispatch/courier/offers/${segment(id)}/accept`,
  declineOffer: (id: string) => `/dispatch/courier/offers/${segment(id)}/decline`,
  delivery: (id: string) => `/delivery/courier/deliveries/${segment(id)}`,
  deliveryEvents: (id: string) => `/delivery/courier/deliveries/${segment(id)}/events`,
  proofPhotos: (id: string) => `/delivery/courier/deliveries/${segment(id)}/proof-photos`,
  pings: '/tracking/courier/pings',
  earnings: '/payouts/courier/me/summary',
  profile: '/fleet/courier/me',
  vehicles: '/fleet/courier/me/vehicles',
  documents: '/fleet/courier/me/documents',
  payoutOnboarding: '/payouts/courier/me/onboarding-link',
  balance: (limit: number) => `/payouts/courier/me/balance?limit=${Math.trunc(limit)}`,
} as const;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

interface Options {
  readonly baseUrl: string;
  readonly session: SessionSource;
  /** The Market the app is built for; sign-in is scoped to it, then the session carries it. */
  readonly marketId: string;
  readonly fetch?: Fetch;
  /** Where the accepted delivery is kept while fleet reports none; nothing is kept without it. */
  readonly activeJob?: ActiveJobMemory;
  /** Milliseconds before a call is abandoned. */
  readonly timeoutMs?: number;
}

/** The delivery API's event body (presentation/delivery.schemas.ts). */
function eventBody(event: JobEvent): Record<string, unknown> {
  switch (event.type) {
    case 'delivery_failed':
      return {
        type: event.type,
        reason: event.details?.trim() ? `${event.reason}: ${event.details.trim()}` : event.reason,
      };
    default:
      return event;
  }
}

export function createHttpCourierApi(options: Options): CourierApi {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const activeJob = options.activeJob;

  /** A finished job, or one the courier no longer has (404), is no longer the active one. */
  async function followJob<T extends { id: string; status: Job['status'] }>(
    deliveryId: string,
    load: () => Promise<T>,
  ): Promise<T> {
    try {
      const loaded = await load();
      if (activeJob?.current() === deliveryId && FINISHED.has(loaded.status)) {
        await activeJob.forget();
      }
      return loaded;
    } catch (error) {
      // 404: not (or no longer) the courier's; id.invalid: an id the API never issued.
      const gone =
        error instanceof ApiError && (error.status === 404 || error.code === 'id.invalid');
      if (gone && activeJob?.current() === deliveryId) {
        await activeJob.forget();
      }
      throw error;
    }
  }

  async function call<T>(
    method: string,
    route: string | (() => string),
    schema: z.ZodType<T> | null,
    body?: unknown,
    { authenticated = true }: { authenticated?: boolean } = {},
  ): Promise<T> {
    const path = typeof route === 'string' ? route : route();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (authenticated) {
      const session = options.session.current();
      if (!session) throw new ApiError(401, 'session.missing');
      headers.authorization = `Bearer ${session.token}`;
      headers['x-market-id'] = session.marketId;
    } else {
      headers['x-market-id'] = options.marketId;
    }
    let payload: BodyInit | undefined;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });
    } catch {
      throw new ApiError(0, 'network.unavailable');
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const json: unknown = text ? safeJson(text) : undefined;
    if (!response.ok) {
      const parsed = apiError.safeParse(json);
      throw new ApiError(response.status, parsed.success ? parsed.data.code : 'http.error');
    }
    if (!schema) return undefined as T;
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiError(response.status, 'response.invalid');
    return parsed.data;
  }

  /** The server's active delivery, or the one the courier accepted on this device. */
  function withActiveJob(status: CourierStatus): CourierStatus {
    return status.activeDeliveryId
      ? status
      : { ...status, activeDeliveryId: activeJob?.current() ?? null };
  }

  return {
    signIn: async (input) => {
      const signedIn = await call('POST', ROUTES.signIn, courierSignedIn, input, {
        authenticated: false,
      });
      return courierSession.parse({ token: signedIn.token, marketId: options.marketId });
    },
    signOut: () => call('POST', ROUTES.signOut, null, {}),
    settings: () => call('GET', ROUTES.settings, courierSettings),
    status: async () => withActiveJob(await call('GET', ROUTES.status, courierStatus)),
    setShift: async (state) =>
      withActiveJob(await call('PUT', ROUTES.shift, courierStatus, { state })),
    currentOffer: async () => (await call('GET', ROUTES.currentOffer, currentOffer)).offer,
    acceptOffer: async (offerId) => {
      const accepted = await call('POST', () => ROUTES.acceptOffer(offerId), offerAccepted, {});
      await activeJob?.remember(accepted.deliveryId);
      return accepted;
    },
    declineOffer: (offerId) => call('POST', () => ROUTES.declineOffer(offerId), null, {}),
    job: (deliveryId) =>
      followJob(deliveryId, () => call('GET', () => ROUTES.delivery(deliveryId), job)),
    recordEvent: (deliveryId, event) =>
      followJob(deliveryId, () =>
        call('POST', () => ROUTES.deliveryEvents(deliveryId), job, eventBody(event)),
      ),
    uploadProofPhoto: (deliveryId, photo: PhotoFile) => {
      const form = new FormData();
      // React Native's FormData takes a file as { uri, name, type }.
      form.append('photo', {
        uri: photo.uri,
        name: 'proof.jpg',
        type: photo.mimeType,
      } as unknown as Blob);
      return call('POST', () => ROUTES.proofPhotos(deliveryId), proofPhoto, form);
    },
    sendPings: (pings) => call('POST', ROUTES.pings, null, { pings }),
    earnings: () => call('GET', ROUTES.earnings, earningsSummary),
    profile: async () => {
      try {
        return (await call('GET', ROUTES.profile, courierMe)).profile;
      } catch (error) {
        // Before the courier applies, fleet has no profile for the account.
        if (error instanceof ApiError && error.code === 'fleet.courier.not-found') return null;
        throw error;
      }
    },
    // The settings answer carries the rules once fleet sends them; until then there are none.
    onboardingRules: () => call('GET', ROUTES.settings, onboardingRules.nullable().catch(null)),
    applyAsCourier: (input) => call('POST', ROUTES.profile, courierProfile, input),
    addVehicle: (input) => call('POST', ROUTES.vehicles, courierProfile, input),
    submitDocument: async (upload: DocumentUpload) => {
      const form = new FormData();
      form.append('type', upload.type);
      if (upload.vehicleId !== undefined) form.append('vehicleId', segment(upload.vehicleId));
      if (upload.expiresAt !== undefined) form.append('expiresAt', upload.expiresAt);
      // React Native's FormData takes a file as { uri, name, type }.
      form.append('file', {
        uri: upload.file.uri,
        name: upload.file.name,
        type: upload.file.mimeType,
      } as unknown as Blob);
      return (await call('POST', ROUTES.documents, documentSubmitted, form)).profile;
    },
    payoutOnboardingLink: () => call('POST', ROUTES.payoutOnboarding, payoutOnboardingLink, {}),
    balance: (limit) => call('GET', () => ROUTES.balance(limit), earningsBalance),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
