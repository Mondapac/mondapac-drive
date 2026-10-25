import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseMarketId, POPULATIONS } from '@mondapac-drive/shared-kernel';
import type { MarketId, Population } from '@mondapac-drive/shared-kernel';
import { z } from 'zod';
import { routingConfigSchema } from '../routing/routing-config';
import { notificationsSchema } from './notifications-section';
import { payoutsSchema } from './payouts-config';

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

// Market locales always name a region: language[-Script]-REGION.
const LOCALE_SHAPE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?-[A-Z]{2}$/;
const locale = z.string().refine((value) => {
  if (!LOCALE_SHAPE.test(value)) return false;
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}, 'must be a BCP 47 locale of the form language-REGION');
const currency = z.string().refine((value) => CURRENCIES.has(value), 'must be an ISO 4217 code');
/** The Market code, by the kernel's single rule (`parseMarketId`). */
const marketCode = z.string().transform((value, context) => {
  const marketId = parseMarketId(value);
  if (marketId.ok) return marketId.value;
  context.addIssue('must be a market code such as "NZ"');
  return z.NEVER;
});

/** A per-minute limit of the generic per-origin rate limiter (identity design 6.8). */
const perMinute = z.number().int().min(1).max(100_000);

/**
 * Limits of the generic per-origin rate limiter (`platform/rate-limit/`; identity design 6.8,
 * ADR-0015 decision 3). The counters are kept per origin and are not split by Market (PF I11):
 * the limiter is the cross-Market control, and the request's Market chooses only the limit.
 */
const requestLimitsSchema = z.strictObject({
  /** Routes marked `@RateLimit('anonymous-identity')`: sign-up, sign-in, reset requests. */
  anonymousIdentityPerMinute: perMinute,
  /** Every other market-scoped route. */
  defaultPerMinute: perMinute,
});

/** Minutes, at most 60 days: the unit of every lifetime, window and block below. */
const minutes = z.number().int().min(1).max(86_400);

/**
 * A session lifetime of one population (marketplace identity design 6.1): the idle timeout and
 * the absolute lifetime, both fixed on the session at creation.
 */
const sessionLifetimeSchema = z
  .strictObject({ idleTimeoutMinutes: minutes, absoluteLifetimeMinutes: minutes })
  .refine((lifetime) => lifetime.idleTimeoutMinutes <= lifetime.absoluteLifetimeMinutes, {
    message: 'idleTimeoutMinutes must not exceed absoluteLifetimeMinutes',
    path: ['idleTimeoutMinutes'],
  });

/**
 * The admin session (marketplace identity design 6.1; HF6): at most 30 minutes idle and 12
 * hours absolute, never persistent.
 */
const adminSessionLifetimeSchema = z
  .strictObject({
    idleTimeoutMinutes: z.number().int().min(1).max(30),
    absoluteLifetimeMinutes: z.number().int().min(1).max(720),
  })
  .refine((lifetime) => lifetime.idleTimeoutMinutes <= lifetime.absoluteLifetimeMinutes, {
    message: 'idleTimeoutMinutes must not exceed absoluteLifetimeMinutes',
    path: ['idleTimeoutMinutes'],
  });

/**
 * One throttle counter: at most `limit` attempts in a fixed window of `windowMinutes`; a failure
 * that reaches the limit blocks the counter for `blockMinutes` (0: no block, the window alone
 * refuses until it ends).
 */
const throttleCounterSchema = z.strictObject({
  limit: z.number().int().min(1).max(1000),
  windowMinutes: z.number().int().min(1).max(1440),
  blockMinutes: z.number().int().min(0).max(1440),
});

/** Hosts a browser resolves to this machine only: the one place plain http is allowed. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a URL host name is a loopback host: `localhost`, `*.localhost`, `127.0.0.1` or
 * `[::1]`. The one rule for plain http, shared by the link pages and `allowedOrigins`, so the
 * two can never drift apart.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/**
 * A page a mail links to: an absolute https URL without a fragment (the token goes there) and
 * without credentials. Plain http is accepted only for a loopback host, for local development,
 * so a mailed token never crosses a network in clear text.
 */
const pageUrl = z
  .string()
  .max(200)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && isLoopbackHostname(url.hostname))) &&
        !value.includes('#') &&
        url.username === '' &&
        url.password === ''
      );
    } catch {
      return false;
    }
  }, 'must be an absolute https URL (http only for a loopback host) without a fragment, such as "https://panel.example/page"');

/** The origin and the host name of a page URL, or null when it does not parse. */
function hostOf(page: string): { readonly origin: string; readonly hostname: string } | null {
  try {
    const url = new URL(page);
    return { origin: url.origin, hostname: url.hostname };
  } catch {
    return null;
  }
}

/**
 * The page a mail links to, per population and page (`LinkTargets`). Admins get the dispatch
 * panel's four sign-in pages, given together or not at all; couriers get the pages the courier
 * app opens (its universal links). Merchants get no mail: an operator hands them their keys.
 * Each population's pages are on one origin, and never on another population's host.
 */
const linkTargetsSchema = z
  .strictObject({
    admin: z
      .strictObject({
        'sign-in': pageUrl,
        'accept-invitation': pageUrl,
        'enrol-second-factor': pageUrl,
        'reset-password': pageUrl,
      })
      .optional(),
    courier: z
      .strictObject({
        'sign-in': pageUrl,
        'accept-invitation': pageUrl,
        'reset-password': pageUrl,
      })
      .optional(),
  })
  .superRefine((targets, context) => {
    const populations = ['admin', 'courier'] as const;
    for (const population of populations) {
      const pages = targets[population];
      if (pages === undefined) continue;
      // A population's token is only ever mailed to its own app, never to another host a config
      // change might name.
      const signIn = hostOf(pages['sign-in']);
      for (const [page, url] of Object.entries(pages)) {
        if (signIn === null) continue;
        if (hostOf(url)?.origin !== signIn.origin) {
          context.addIssue({
            code: 'custom',
            message: `a ${population} page must have the origin of the ${population} sign-in page`,
            path: [population, page],
          });
        }
      }
    }
    // The admin panel is a host of its own (HF7): origins and host names both.
    if (targets.admin === undefined || targets.courier === undefined) return;
    const courierHosts = new Set(
      Object.values(targets.courier)
        .map((url) => hostOf(url)?.hostname)
        .filter((hostname) => hostname !== undefined),
    );
    for (const [page, url] of Object.entries(targets.admin)) {
      const hostname = hostOf(url)?.hostname;
      if (hostname !== undefined && courierHosts.has(hostname)) {
        context.addIssue({
          code: 'custom',
          message: 'an admin page must not share its host name with a courier page',
          path: ['admin', page],
        });
      }
    }
  });

/**
 * The identity policy section (the marketplace's `IdentityMarketPolicy`, adapted to Drive's
 * populations). A population without a session lifetime here cannot open a session, and every
 * optional value fails closed when absent (`access.unavailable`).
 */
const identitySchema = z
  .strictObject({
    password: z
      .strictObject({
        /** Code points after NFKC; never below 15 (NIST SP 800-63B-4, single factor). */
        minLength: z.number().int().min(15).max(128),
        /** Code points after NFKC; at most 128, so the raw-input bound of 1024 bytes holds. */
        maxLength: z.number().int().min(64).max(128),
      })
      .refine((password) => password.minLength <= password.maxLength, {
        message: 'minLength must not exceed maxLength',
        path: ['minLength'],
      }),
    /** Per population that signs in with a password. */
    sessions: z.strictObject({
      /** The dispatch panel (30 minutes idle, 12 hours absolute at most). */
      admin: adminSessionLifetimeSchema.optional(),
      /** The courier app: a shift-long idle timeout, re-sign-in at least monthly. */
      courier: sessionLifetimeSchema.optional(),
    }),
    /**
     * Merchant API keys: how long a key lives from its issue, in days (at most two years). A key
     * has no idle timeout: the marketplace may book nothing for weeks. Without it no key is
     * issued.
     */
    apiKeys: z.strictObject({ lifetimeDays: z.number().int().min(1).max(730) }).optional(),
    /** The sign-in counters. */
    signInThrottles: z.strictObject({
      /** `sign-in.account-origin`: failed sign-ins per address and origin. */
      accountOrigin: throttleCounterSchema,
      /** `sign-in.account`: failed sign-ins per address, all origins. */
      account: throttleCounterSchema,
      /** `sign-in.origin`: failed sign-ins per origin, any address. */
      origin: throttleCounterSchema,
    }),
    /** The mail counters: reset, enrolment, invitation. */
    mailThrottles: z.strictObject({
      account: throttleCounterSchema,
      origin: throttleCounterSchema,
    }),
    /** Sign-in records are deleted this many days after the attempt. */
    signInRecordRetentionDays: z.number().int().min(1).max(3650),
    /**
     * One-time links: `lifetimeMinutes` per purpose, from the issue (a reset link exactly 60
     * minutes, in every Market); a purpose without one is never issued. `targets`: the page a
     * mail links to, per population and page.
     */
    links: z.strictObject({
      lifetimeMinutes: z.strictObject({
        'reset-password': z.literal(60),
        /** The admin's enrolment link, at most 60 minutes. */
        'enrol-second-factor': z.number().int().min(1).max(60).optional(),
      }),
      targets: linkTargetsSchema,
    }),
    /**
     * Invitations: the lifetime per kind from the dispatch. An admin invitation lives at most 72
     * hours, a courier's at most 7 days. A kind without one is never issued.
     */
    invitations: z
      .strictObject({
        lifetimeMinutes: z.strictObject({
          admin: z
            .number()
            .int()
            .min(1)
            .max(72 * 60)
            .optional(),
          courier: z
            .number()
            .int()
            .min(1)
            .max(7 * 24 * 60)
            .optional(),
        }),
      })
      .optional(),
    /** The sign-in challenge of the code step: at most 5 code checks and 5 minutes. */
    challenges: z
      .strictObject({
        maxAttempts: z.number().int().min(1).max(5),
        lifetimeSeconds: z.number().int().min(30).max(300),
      })
      .optional(),
    /**
     * The `second-factor.account` counter: at most 10 failed codes in a window of at least 24
     * hours, then a block of at least 24 hours (never 0: the block is the lock).
     */
    secondFactorThrottles: z
      .strictObject({
        account: z.strictObject({
          limit: z.number().int().min(1).max(10),
          windowMinutes: z
            .number()
            .int()
            .min(24 * 60)
            .max(7 * 24 * 60),
          blockMinutes: z
            .number()
            .int()
            .min(24 * 60)
            .max(7 * 24 * 60),
        }),
      })
      .optional(),
    /** The `sign-out-others.account` counter: how often the holder signs out the other sessions. */
    signOutOthersThrottle: z
      .strictObject({
        limit: z.number().int().min(1).max(20),
        windowMinutes: z
          .number()
          .int()
          .min(10)
          .max(24 * 60),
        blockMinutes: z
          .number()
          .int()
          .min(0)
          .max(24 * 60),
      })
      .optional(),
    /** Custom platform roles a Market allows; without it the role editor's create fails closed. */
    customRoleLimits: z.strictObject({ platform: z.number().int().min(1).max(500) }).optional(),
    /** The sender of the Market's mail. */
    mail: z.strictObject({
      fromAddress: z.email().max(254),
      fromName: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[^\p{Cc}\p{Cf}"<>]+$/u, 'must be plain text without control or format characters'),
    }),
  })
  .superRefine((identity, context) => {
    // Admin sign-in is configured whole or not at all: an admin session needs the challenge, the
    // second-factor counter, the enrolment link, the admin pages and the invitation lifetime.
    if (identity.sessions.admin !== undefined) {
      const missing = [
        identity.challenges === undefined ? 'challenges' : null,
        identity.secondFactorThrottles === undefined ? 'secondFactorThrottles' : null,
        identity.links.lifetimeMinutes['enrol-second-factor'] === undefined
          ? 'links.lifetimeMinutes.enrol-second-factor'
          : null,
        identity.links.targets.admin === undefined ? 'links.targets.admin' : null,
        identity.invitations?.lifetimeMinutes.admin === undefined
          ? 'invitations.lifetimeMinutes.admin'
          : null,
      ].filter((key) => key !== null);
      if (missing.length > 0) {
        context.addIssue({
          code: 'custom',
          message: `sessions.admin needs ${missing.join(', ')}`,
          path: ['sessions', 'admin'],
        });
      }
    }
    // Courier sign-in likewise needs its pages and its invitation lifetime.
    if (identity.sessions.courier !== undefined) {
      const missing = [
        identity.links.targets.courier === undefined ? 'links.targets.courier' : null,
        identity.invitations?.lifetimeMinutes.courier === undefined
          ? 'invitations.lifetimeMinutes.courier'
          : null,
      ].filter((key) => key !== null);
      if (missing.length > 0) {
        context.addIssue({
          code: 'custom',
          message: `sessions.courier needs ${missing.join(', ')}`,
          path: ['sessions', 'courier'],
        });
      }
    }
  });

/**
 * One exact origin (`scheme://host[:port]`, no path, no credentials) a browser may send an unsafe
 * request from. https, or plain http only for a loopback host.
 */
const allowedOrigin = z
  .string()
  .max(200)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && isLoopbackHostname(url.hostname))) &&
        url.origin === value
      );
    } catch {
      return false;
    }
  }, 'must be an exact https origin (http only for a loopback host) such as "https://panel.example"');

/** One population's list: at most 20 origins, none twice. Empty: every `Origin` is refused. */
const originList = z
  .array(allowedOrigin)
  .max(20)
  .superRefine((origins, context) => {
    origins.forEach((origin, index) => {
      if (origins.indexOf(origin) !== index) {
        context.addIssue({ code: 'custom', message: 'an origin must not repeat', path: [index] });
      }
    });
  });

/** The host name of an origin or page URL, or null when it does not parse. */
function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * The origins whose browsers may send an unsafe request to this Market's routes, per population
 * of the route (marketplace identity design 6.4, HF14): an admin route checks only `admin`, a
 * merchant route only `merchant`, a courier route only `courier`. All three keys are required;
 * an empty list fails closed (every request with an `Origin` header is refused), and admin routes
 * also refuse a request without the header (in code, `csrf.ts`). The lists are disjoint by host
 * name, so the same host on another scheme or port is refused too.
 */
const allowedOriginsSchema = z
  .strictObject({ admin: originList, merchant: originList, courier: originList })
  .superRefine((lists, context) => {
    POPULATIONS.forEach((population, index) => {
      const earlier = new Set(
        POPULATIONS.slice(0, index).flatMap((other) =>
          lists[other].map(hostnameOf).filter((hostname) => hostname !== null),
        ),
      );
      lists[population].forEach((origin, position) => {
        const hostname = hostnameOf(origin);
        if (hostname !== null && earlier.has(hostname)) {
          context.addIssue({
            code: 'custom',
            message: "an origin must not share its host name with another population's origin",
            path: [population, position],
          });
        }
      });
    });
  });

/** The pages of one population's link targets. */
function linkPagesOf(targets: object | undefined): string[] {
  return targets === undefined
    ? []
    : Object.values(targets).filter((page): page is string => typeof page === 'string');
}

/**
 * The cross-check of `allowedOrigins` and the link targets: a non-empty list holds the origin of
 * every page its own population's mails link to, so a linked page can post back; and no list
 * shares a host name with another population's pages.
 */
function checkOriginsAgainstLinkTargets(
  market: {
    readonly allowedOrigins: Readonly<Record<Population, readonly string[]>>;
    readonly identity: {
      readonly links: { readonly targets: Partial<Record<Population, object>> };
    };
  },
  context: z.RefinementCtx,
): void {
  const { allowedOrigins, identity } = market;
  for (const population of POPULATIONS) {
    const list = allowedOrigins[population];
    if (list.length > 0) {
      for (const page of linkPagesOf(identity.links.targets[population])) {
        const origin = hostOf(page)?.origin;
        if (origin !== undefined && !list.includes(origin)) {
          context.addIssue({
            code: 'custom',
            message: `must hold the origin of every ${population} link page (${origin})`,
            path: ['allowedOrigins', population],
          });
        }
      }
    }
    const otherHosts = new Set(
      POPULATIONS.filter((other) => other !== population)
        .flatMap((other) => linkPagesOf(identity.links.targets[other]))
        .map(hostnameOf)
        .filter((hostname) => hostname !== null),
    );
    list.forEach((origin, index) => {
      const hostname = hostnameOf(origin);
      if (hostname !== null && otherHosts.has(hostname)) {
        context.addIssue({
          code: 'custom',
          message: "an origin must not share its host name with another population's link page",
          path: ['allowedOrigins', population, index],
        });
      }
    });
  }
}

/** Vehicle types in order of size (delivery domain); a Market's rate card offers some of them. */
export const VEHICLE_TYPES = ['bicycle', 'motorbike', 'car', 'van'] as const;
/** Parcel temperatures; chilled and frozen need cold-chain readings on the way. */
export const TEMPERATURES = ['ambient', 'chilled', 'frozen'] as const;

/** Minor units of the Market's currency. */
const minor = z.number().int().nonnegative().max(10_000_000);
const basisPoints = z.number().int().min(0).max(10_000);

/** One vehicle's prices and limits. */
const vehicleRateSchema = z.strictObject({
  baseFee: minor,
  perKm: minor,
  maxDistanceMetres: z.number().int().positive(),
  maxWeightGrams: z.number().int().positive(),
  maxVolumeLitres: z.number().int().positive(),
  temperatures: z.array(z.enum(TEMPERATURES)).min(1),
});

/**
 * The `delivery` section, owned by the delivery module (Drive's addition to the marketplace's
 * Market file): the rate card, the cold-chain limits and the scheduling rules. Service areas are
 * the platform's `config/service-areas/<CODE>.json`.
 */
const deliverySchema = z.strictObject({
  rateCard: z
    .strictObject({
      vehicles: z.partialRecord(z.enum(VEHICLE_TYPES), vehicleRateSchema),
      coldChainSurcharge: z.strictObject({ ambient: minor, chilled: minor, frozen: minor }),
      scheduledDiscountBps: basisPoints,
    })
    .refine((card) => Object.keys(card.vehicles).length > 0, {
      message: 'the rate card offers no vehicle',
      path: ['vehicles'],
    }),
  coldChain: z.strictObject({
    chilled: z.strictObject({ maxCelsius: z.number().min(-40).max(15) }),
    frozen: z.strictObject({ maxCelsius: z.number().min(-40).max(0) }),
  }),
  scheduling: z.strictObject({
    minLeadMinutes: z.number().int().nonnegative(),
    maxDaysAhead: z.number().int().positive().max(90),
    minWindowMinutes: z.number().int().positive(),
  }),
  /**
   * The recipient's PIN: its digits, and how many wrong PINs a delivery takes before the
   * courier must prove the hand-over with a photo instead.
   */
  proofOfDelivery: z.strictObject({
    pinLength: z.number().int().min(4).max(8),
    maxPinAttempts: z.number().int().min(1).max(10),
  }),
});

/**
 * The `dispatch` section, owned by the dispatch module: how offers go out to couriers (accept
 * timeout, couriers per wave, rounds before a dispatcher takes over), when a scheduled delivery
 * opens for dispatch, and how far and how many nearby couriers are considered.
 */
const dispatchSchema = z.strictObject({
  offerTimeoutSeconds: z.number().int().min(5).max(600),
  waveSize: z.number().int().min(1).max(20),
  maxRounds: z.number().int().min(1).max(50),
  scheduledLeadMinutes: z.number().int().nonnegative().max(1440),
  searchRadiusMetres: z.number().int().positive().max(200_000),
  candidateLimit: z.number().int().min(1).max(200),
  /**
   * Decimal places of the drop-off point an offer shows before accept (security L3): 3 is a
   * cell of about 110 m, so the point names a street block, not a house. At most 4 (about 11 m).
   */
  offerPointDecimals: z.number().int().min(1).max(4),
});

/** Whole seconds, bounded so a typo cannot disable a check. */
const seconds = (max: number) => z.number().int().positive().max(max);

/**
 * The `tracking` section, owned by the tracking module: which courier location pings are
 * accepted, how long a live position and a breadcrumb trail are kept (personal data, Privacy
 * Act: the trail's retention is the Market's decision), how long a customer tracking link lives,
 * and how often the ETA is asked of routing.
 */
const trackingSchema = z.strictObject({
  ping: z.strictObject({
    /** A ping recorded longer ago than this is stale and refused. */
    maxAgeSeconds: seconds(3600),
    /** A ping recorded further ahead of the server clock than this is refused. */
    maxFutureSkewSeconds: seconds(300),
    /** One accepted ping per courier per this many seconds; the others are throttled. */
    minIntervalSeconds: seconds(300),
    maxAccuracyMetres: z.number().int().positive().max(10_000),
    maxSpeedKmh: z.number().int().positive().max(400),
  }),
  /** A courier without a ping for this long drops out of the live map and of dispatch. */
  livePositionTtlSeconds: seconds(86_400),
  breadcrumbRetentionDays: z.number().int().positive().max(365),
  trackingLinkTtlHours: z.number().int().positive().max(720),
  /** How often the tracking page's live channel sends a new view. */
  streamIntervalSeconds: seconds(60),
  nearestCouriers: z.strictObject({
    maxRadiusMetres: z.number().int().positive().max(200_000),
    maxResults: z.number().int().positive().max(500),
  }),
  /** How long one road ETA (platform routing) is reused before routing is asked again. */
  etaRefreshSeconds: seconds(600),
});

/** Employment types of the hybrid fleet (fleet domain). */
export const EMPLOYMENT_TYPES = ['employee', 'contractor'] as const;

/**
 * The `fleet` section, owned by the fleet module: the documents the Market requires of its
 * couriers. A document type is the Market's own code (`abn` in AU), never a list in core code.
 */
const fleetSchema = z
  .strictObject({
    documents: z
      .array(
        z.strictObject({
          type: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'must be a lower-case code'),
          employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).min(1).optional(),
          vehicleTypes: z.array(z.enum(VEHICLE_TYPES)).min(1).optional(),
          coldChainOnly: z.boolean(),
          perVehicle: z.boolean(),
          expires: z.boolean(),
        }),
      )
      .max(50)
      .refine((documents) => new Set(documents.map((d) => d.type)).size === documents.length, {
        message: 'each document type is listed once',
      }),
    /**
     * The document that proves a contractor's business registration (`abn` in AU), which payouts
     * reads as "business id verified". One of `documents`, of the courier, not of a vehicle.
     */
    businessIdDocumentType: z.string().optional(),
    /** What the courier app shows: the support line couriers call, and the unit of distances. */
    courierApp: z.strictObject({
      /** E.164, as the app dials it. */
      supportPhone: z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'must be an E.164 phone number'),
      distanceUnit: z.enum(['km', 'mi']),
    }),
  })
  .refine(
    (fleet) =>
      fleet.businessIdDocumentType === undefined ||
      fleet.documents.some((d) => d.type === fleet.businessIdDocumentType && !d.perVehicle),
    {
      message: "businessIdDocumentType must name one of the courier's own documents",
      path: ['businessIdDocumentType'],
    },
  );

const marketSchema = z
  .strictObject({
    code: marketCode,
    status: z.enum(['planned', 'soft_launch', 'active', 'suspended']),
    defaultLocale: locale,
    supportedLocales: z.array(locale).min(1),
    defaultCurrency: currency,
    settlementCurrency: currency,
    /**
     * The Market's price display convention (marketplace ADR-0007 decision 4): true when prices
     * are entered and shown tax-inclusive (AU). Required: a Market never defaults it.
     */
    pricesIncludeTax: z.boolean(),
    /** Fallback only (ADR-0005): areas, depots and addresses may carry their own zone. */
    timezone: z.string().refine((value) => TIME_ZONES.has(value), 'must be an IANA time zone'),
    requestLimits: requestLimitsSchema,
    /** `defaultRateBps`: the tax rate inside or on top of a delivery fee (AU GST 1000 = 10 %). */
    tax: z.strictObject({ defaultRateBps: z.number().int().min(0).max(5000) }),
    allowedOrigins: allowedOriginsSchema,
    identity: identitySchema,
    delivery: deliverySchema,
    /** Owned by `platform/routing`; absent, routes are straight-line estimates. */
    routing: routingConfigSchema.optional(),
    dispatch: dispatchSchema,
    tracking: trackingSchema,
    notifications: notificationsSchema,
    fleet: fleetSchema,
    /** Courier earnings and payouts (payouts-config.ts). */
    payouts: payoutsSchema,
  })
  .refine((market) => market.supportedLocales.includes(market.defaultLocale), {
    message: 'supportedLocales must include defaultLocale',
    path: ['supportedLocales'],
  })
  .superRefine(checkOriginsAgainstLinkTargets);

/** Market configuration as code (ADR-0003 decision 5). */
export type MarketConfig = Readonly<z.infer<typeof marketSchema>>;

export class InvalidMarketConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMarketConfigError';
  }
}

/**
 * Reads `<CODE>.json` for each hosted market from the given directories and validates it.
 * Throws when a hosted market has no configuration or an invalid one, so a Region Stack
 * never starts half-configured.
 */
export function loadMarketConfigs(
  directories: readonly string[],
  hostedMarkets: readonly MarketId[],
): ReadonlyMap<MarketId, MarketConfig> {
  const files = new Map<string, string>();
  for (const directory of directories) {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json')) continue;
      const code = path.basename(name, '.json');
      if (files.has(code)) {
        throw new InvalidMarketConfigError(`Market "${code}" is configured more than once`);
      }
      files.set(code, path.join(directory, name));
    }
  }

  const markets = new Map<MarketId, MarketConfig>();
  for (const code of hostedMarkets) {
    const file = files.get(code);
    if (file === undefined) {
      throw new InvalidMarketConfigError(
        `Hosted market "${code}" has no configuration file (${code}.json)`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new InvalidMarketConfigError(`${file} is not valid JSON`);
    }
    const parsed = marketSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'market'}: ${issue.message}`)
        .join('; ');
      throw new InvalidMarketConfigError(`${file} is invalid: ${issues}`);
    }
    if (parsed.data.code !== code) {
      throw new InvalidMarketConfigError(
        `${file} declares code "${parsed.data.code}"; it must match the file name`,
      );
    }
    markets.set(code, deepFreeze(parsed.data));
  }
  return markets;
}

/** Freezes the parsed configuration and every nested section: it never changes after boot. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
