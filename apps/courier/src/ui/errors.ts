import { ApiError } from '../api/client';
import { t, type TranslationKey } from '../i18n';

const MESSAGES: Readonly<Record<string, TranslationKey>> = {
  'delivery.pin-wrong': 'errors.pinMismatch',
  'delivery.pin-locked': 'errors.pinLocked',
  'delivery.proof-photo-unknown': 'errors.photoUnknown',
  'proof-photo.too-large': 'errors.photoRejected',
  'proof-photo.unsupported-type': 'errors.photoRejected',
  'proof-photo.limit-reached': 'errors.photoLimit',
  'proof-photo.storage-unavailable': 'errors.photoStorage',
  'cold-chain.breach': 'errors.coldChainBreach',
  'cold-chain.reading-required': 'errors.coldChainMissing',
  'offer.expired': 'errors.offerExpired',
  'offer.not-found': 'errors.offerGone',
  'offer.not-pending': 'errors.offerGone',
  'dispatch.conflict': 'errors.offerGone',
  'network.unavailable': 'errors.network',
  'session.missing': 'errors.session',
  'fleet.shift.transition-not-allowed': 'errors.deliveryInProgress',
  'fleet.courier.not-found': 'errors.noProfile',
  'fleet.courier.not-eligible': 'errors.notEligible',
  'fleet.courier.not-active': 'errors.notEligible',
  'fleet.courier.suspended': 'errors.notEligible',
  'fleet.courier.offboarded': 'errors.notEligible',
};

/** The courier-facing message for a failed call; never the raw server text. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const key = MESSAGES[error.code] ?? (error.status === 401 ? 'errors.session' : undefined);
    if (key) return t(key);
  }
  return t('errors.generic');
}
