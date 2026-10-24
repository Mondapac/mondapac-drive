import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { Logger } from '@nestjs/common';
import type { Clock } from '@mondapac-drive/shared-kernel';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { MARKET_ID_HEADER } from '../market-context/market-id-header';
import { clientAddressOf } from '../rate-limit/client-origin';
import {
  cidrContains,
  parseIpAddress,
  type ClientAddressKey,
  type ClientAddressTrust,
} from './client-address-trust';

/**
 * The client address of a request (ADR-0037). This file is the only reader of the socket's
 * address (lint rule client-address-is-resolved-once): a middleware resolves the address once,
 * before the body parser, the guards and every controller, and {@link clientAddressFrom} hands
 * it to every reader (the rate limiter, identity's and sellers' presentation code).
 *
 * The address is the socket's, unless the request comes from a BFF network
 * (`TRUSTED_BFF_CIDRS`) with a fresh `x-client-address` proof under a key bound to that network.
 * Every other combination of a BFF network or a proof is refused with
 * `400 client-address.untrusted`, never answered with the socket's address (decision 3).
 */

/** The header a BFF sets (ADR-0037 decision 2). */
export const CLIENT_ADDRESS_HEADER = 'x-client-address';
/** The code of every refusal. */
export const CLIENT_ADDRESS_UNTRUSTED = 'client-address.untrusted';
/** How far `t` may be from the Clock's now, either way (decision 3). */
export const CLIENT_ADDRESS_MAX_SKEW_SECONDS = 60;
/**
 * The platform probes (decision 6): exactly these paths skip the middleware, so a probe from
 * inside a BFF network is never refused. They read no client address.
 */
export const CLIENT_ADDRESS_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/health/ready',
]);

/** Why a request was refused; logged as `reason`, never answered. */
export type ClientAddressRefusal =
  | 'disabled'
  | 'source-untrusted'
  | 'missing'
  | 'repeated'
  | 'malformed'
  | 'market-missing'
  | 'key-unknown'
  | 'key-source-mismatch'
  | 'stale'
  | 'signature-invalid';

/** `v1;k=<keyId>;t=<unix-seconds>;a=<address>;s=<base64url, 43 characters>`. */
const HEADER_FORMAT =
  /^v1;k=([a-z0-9-]{1,32});t=(\d{1,12});a=([0-9A-Fa-f:.]{2,45});s=([A-Za-z0-9_-]{43})$/;

/** The text a proof signs (decision 2). */
export function clientAddressMessage(
  keyId: string,
  unixSeconds: string,
  address: string,
  marketHeader: string,
): string {
  return `v1\n${keyId}\n${unixSeconds}\n${address}\n${marketHeader}`;
}

/**
 * The resolved address of each request. A WeakMap rather than a request property, so no other
 * code can set or overwrite it; a request that did not pass the middleware has none.
 */
const resolved = new WeakMap<IncomingMessage, string | undefined>();

/** The keyId that proved each request's address (every check of decision 3 passed). */
const provenBy = new WeakMap<IncomingMessage, string>();

/**
 * The client address the middleware resolved for this request, as text: the socket's, or the
 * one a BFF proved. `undefined` when there is none (no socket address, or the request did not
 * pass the middleware), which every reader treats as "cannot be evaluated" (fail closed).
 * Readers canonicalise it with `clientOriginOf` and `clientAddressOf`.
 */
export function clientAddressFrom(request: IncomingMessage): string | undefined {
  return resolved.get(request);
}

/**
 * The keyId of the BFF proof that gave this request's client address, or `undefined` when the
 * address is the socket's. The actor guard requires a storefront key of the storefront's seller
 * sign-up calls (`@AcceptsStorefrontOrigin`), which only the storefront's BFF may send.
 */
export function clientAddressKeyIdOf(request: IncomingMessage): string | undefined {
  return provenBy.get(request);
}

/** How many header lines named `name` the request carried (Node joins repeated ones). */
function lineCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() === name) count += 1;
  }
  return count;
}

export interface ClientAddressOptions {
  /** `null` when `TRUSTED_BFF_CIDRS` and `CLIENT_ADDRESS_KEYS` are both empty: the feature is off. */
  readonly trust: ClientAddressTrust | null;
  /** The injected kernel Clock (ADR-0005): the only source of now. */
  readonly clock: Clock;
}

/** The middleware `configureApp` mounts after the request logger and the security headers. */
export function clientAddressResolver(options: ClientAddressOptions): RequestHandler {
  const logger = new Logger('ClientAddress');
  const { trust, clock } = options;

  const refuse = (
    request: IncomingMessage & { id?: unknown },
    response: Response,
    reason: ClientAddressRefusal,
    key: ClientAddressKey | null,
  ): void => {
    // The reason, a configured keyId and the correlation id only: never the address, the
    // signature, the header, the Market header or a key (decision 7).
    logger.warn({
      msg: CLIENT_ADDRESS_UNTRUSTED,
      reason,
      keyId: key?.keyId ?? null,
      correlationId: request.id ?? null,
    });
    response.status(400).json({ statusCode: 400, code: CLIENT_ADDRESS_UNTRUSTED });
  };

  return (request: Request, response: Response, next: NextFunction): void => {
    const path = (request.originalUrl ?? request.url).split('?', 1)[0]!;
    if (CLIENT_ADDRESS_EXEMPT_PATHS.has(path)) {
      next();
      return;
    }
    const socketAddress = request.socket.remoteAddress;
    const lines = lineCount(request, CLIENT_ADDRESS_HEADER);

    if (trust === null) {
      if (lines > 0) return refuse(request, response, 'disabled', null);
      resolved.set(request, socketAddress);
      next();
      return;
    }

    const canonical = clientAddressOf(socketAddress);
    const source = canonical === null ? null : parseIpAddress(canonical);
    const fromBff = source !== null && trust.bffCidrs.some((cidr) => cidrContains(cidr, source));
    if (!fromBff) {
      if (lines > 0) return refuse(request, response, 'source-untrusted', null);
      resolved.set(request, socketAddress);
      next();
      return;
    }

    if (lines === 0) return refuse(request, response, 'missing', null);
    const header = request.headers[CLIENT_ADDRESS_HEADER];
    if (lines > 1 || typeof header !== 'string') {
      return refuse(request, response, 'repeated', null);
    }
    const match = HEADER_FORMAT.exec(header);
    if (match === null || isIP(match[3]!) === 0) {
      return refuse(request, response, 'malformed', null);
    }
    const [, keyId, unixSeconds, address, signature] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    const market = request.headers[MARKET_ID_HEADER];
    if (typeof market !== 'string' || lineCount(request, MARKET_ID_HEADER) !== 1) {
      return refuse(request, response, 'market-missing', null);
    }

    // The keyId and its network, then the time; only then the HMAC (Hassan, condition 4).
    const key = trust.keys.get(keyId);
    if (key === undefined) return refuse(request, response, 'key-unknown', null);
    if (!key.cidrs.some((cidr) => cidrContains(cidr, source))) {
      return refuse(request, response, 'key-source-mismatch', key);
    }
    const skewMs = Math.abs(clock.now().epochMilliseconds - Number(unixSeconds) * 1000);
    if (skewMs > CLIENT_ADDRESS_MAX_SKEW_SECONDS * 1000) {
      return refuse(request, response, 'stale', key);
    }
    const expected = key.secret.sign(clientAddressMessage(keyId, unixSeconds, address, market));
    const given = Buffer.from(signature, 'base64url');
    // One spelling only (Hassan L1): the last character of 43 base64url characters carries two
    // unused bits, so four texts decode to the same bytes; only the canonical one verifies.
    if (
      given.toString('base64url') !== signature ||
      given.length !== expected.length ||
      !timingSafeEqual(given, expected)
    ) {
      return refuse(request, response, 'signature-invalid', key);
    }

    resolved.set(request, address);
    provenBy.set(request, keyId);
    next();
  };
}
