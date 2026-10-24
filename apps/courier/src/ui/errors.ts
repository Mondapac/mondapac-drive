import { ApiError } from '../api/client';
import { t, type TranslationKey } from '../i18n';

const MESSAGES: Readonly<Record<string, TranslationKey>> = {
  'proof.pin-mismatch': 'errors.pinMismatch',
  'cold-chain.breach': 'errors.coldChainBreach',
  'cold-chain.reading-required': 'errors.coldChainMissing',
  'offer.expired': 'errors.offerExpired',
  'offer.not-found': 'errors.offerGone',
  'network.unavailable': 'errors.network',
  'session.missing': 'errors.session',
  'shift.delivery-in-progress': 'errors.deliveryInProgress',
};

/** The courier-facing message for a failed call; never the raw server text. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const key = MESSAGES[error.code] ?? (error.status === 401 ? 'errors.session' : undefined);
    if (key) return t(key);
  }
  return t('errors.generic');
}
