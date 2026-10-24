import type { z } from 'zod';
import {
  ApiError,
  type CourierApi,
  type JobEvent,
  type PhotoFile,
  type SessionSource,
} from './client';
import {
  apiError,
  courierSession,
  courierSignedIn,
  courierSettings,
  courierStatus,
  currentOffer,
  earningsSummary,
  job,
  offerAccepted,
  proofPhoto,
} from './schemas';

/** An id as the API issues it; anything else (such as `..`) never reaches a path. */
function segment(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ApiError(400, 'id.invalid');
  return id;
}

/**
 * The routes the app calls. Identity, the courier delivery routes and tracking exist on main;
 * fleet, dispatch, payouts and the proof-photo upload are proposals for the packages that own
 * them and change here, in one place, when those routes land.
 */
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
} as const;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

interface Options {
  readonly baseUrl: string;
  readonly session: SessionSource;
  /** The Market the app is built for; sign-in is scoped to it, then the session carries it. */
  readonly marketId: string;
  readonly fetch?: Fetch;
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

  return {
    signIn: async (input) => {
      const signedIn = await call('POST', ROUTES.signIn, courierSignedIn, input, {
        authenticated: false,
      });
      return courierSession.parse({ token: signedIn.token, marketId: options.marketId });
    },
    signOut: () => call('POST', ROUTES.signOut, null, {}),
    settings: () => call('GET', ROUTES.settings, courierSettings),
    status: () => call('GET', ROUTES.status, courierStatus),
    setShift: (state) => call('PUT', ROUTES.shift, courierStatus, { state }),
    currentOffer: async () => (await call('GET', ROUTES.currentOffer, currentOffer)).offer,
    acceptOffer: (offerId) => call('POST', () => ROUTES.acceptOffer(offerId), offerAccepted, {}),
    declineOffer: (offerId) => call('POST', () => ROUTES.declineOffer(offerId), null, {}),
    job: (deliveryId) => call('GET', () => ROUTES.delivery(deliveryId), job),
    recordEvent: (deliveryId, event) =>
      call('POST', () => ROUTES.deliveryEvents(deliveryId), job, eventBody(event)),
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
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
