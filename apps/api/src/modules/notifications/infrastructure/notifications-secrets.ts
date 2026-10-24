import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { AppConfig } from '../../../platform/config/app-config';

/** The webhook key is missing or too short where a real one is required. */
export class WebhookKeyRefusedError extends Error {
  override readonly name = 'WebhookKeyRefusedError';
  constructor(reason: string) {
    super(`NOTIFICATIONS_WEBHOOK_KEY: ${reason}`);
  }
}

/** The fewest bytes the webhook key may have. */
export const MIN_WEBHOOK_KEY_BYTES = 32;

/**
 * The deployment's webhook key, from which every subscription's secret is derived:
 * `NOTIFICATIONS_WEBHOOK_KEY`, base64 of at least 32 random bytes. Anywhere but an explicit
 * `development` or `test` run an unset or short key stops the process at start-up. The value
 * is never logged.
 *
 * Unset in such a run, a local stand-in is used, guarded (Hassan L3 on package 11) so that a
 * deployment started with the wrong NODE_ENV cannot sign with a key anyone can compute from
 * this file: it is refused when Twilio credentials are set (only a real deployment sends SMS),
 * and it is derived from the constant together with `DATABASE_URL`, whose credentials are the
 * deployment's own, so the API and the worker of one environment agree and no other can
 * reproduce it.
 */
export function webhookKey(
  env: Readonly<Record<string, string | undefined>>,
  environment: Pick<AppConfig, 'nodeEnv' | 'nodeEnvExplicit' | 'databaseUrl'>,
): Uint8Array {
  const raw = env.NOTIFICATIONS_WEBHOOK_KEY;
  if (raw !== undefined && raw !== '') {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) throw new WebhookKeyRefusedError('not base64');
    const key = Buffer.from(raw, raw.includes('-') || raw.includes('_') ? 'base64url' : 'base64');
    if (key.length < MIN_WEBHOOK_KEY_BYTES) {
      throw new WebhookKeyRefusedError(`at least ${MIN_WEBHOOK_KEY_BYTES} bytes`);
    }
    return new Uint8Array(key);
  }
  const { nodeEnv, nodeEnvExplicit } = environment;
  if (nodeEnvExplicit !== true || (nodeEnv !== 'development' && nodeEnv !== 'test')) {
    throw new WebhookKeyRefusedError('required outside an explicit development or test run');
  }
  if ((env.TWILIO_ACCOUNT_SID ?? '') !== '' || (env.TWILIO_AUTH_TOKEN ?? '') !== '') {
    throw new WebhookKeyRefusedError('required wherever Twilio credentials are set');
  }
  new Logger('NotificationsWebhookKey').warn({
    msg: 'notifications.webhook-key.local-stand-in',
    nodeEnv,
    note: 'webhook secrets derive from the local stand-in key, which protects nothing',
  });
  return new Uint8Array(
    createHash('sha256')
      .update('mondapac-drive.notifications.webhook-key.stand-in.v2\0')
      .update(environment.databaseUrl)
      .digest(),
  );
}

/** Twilio's account and token, or null when SMS is not configured (`TWILIO_*`). */
export interface TwilioCredentials {
  readonly accountSid: string;
  /** A secret: never logged. */
  readonly authToken: string;
}

export function twilioCredentials(
  env: Readonly<Record<string, string | undefined>>,
): TwilioCredentials | null {
  const accountSid = env.TWILIO_ACCOUNT_SID ?? '';
  const authToken = env.TWILIO_AUTH_TOKEN ?? '';
  if (accountSid === '' && authToken === '') return null;
  if (!/^AC[0-9a-f]{32}$/.test(accountSid) || !/^[0-9a-f]{32}$/.test(authToken)) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must both be set and well formed');
  }
  return { accountSid, authToken };
}
