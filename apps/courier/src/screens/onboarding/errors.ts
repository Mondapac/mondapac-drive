import { ApiError } from '../../api/client';
import { t, type TranslationKey } from '../../i18n';
import { errorMessage } from '../../ui/errors';

/** Fleet's and payouts' refusals during onboarding, in the courier's words. */
const MESSAGES: Readonly<Record<string, TranslationKey>> = {
  'fleet.service-area.unknown': 'onboarding.errors.serviceArea',
  'fleet.vehicle.type-not-offered': 'onboarding.errors.typeNotOffered',
  'fleet.vehicle.plate-required': 'onboarding.errors.plateRequired',
  'fleet.vehicle.plate-invalid': 'onboarding.vehicle.plateInvalid',
  'fleet.vehicle.plate-taken': 'onboarding.errors.plateTaken',
  'fleet.document.type-unknown': 'onboarding.errors.documentType',
  'fleet.document.expiry-required': 'onboarding.errors.expiryRequired',
  'fleet.document.expired': 'onboarding.errors.documentExpired',
  'fleet.document.size': 'onboarding.errors.documentSize',
  'request.body-too-large': 'onboarding.errors.documentSize',
  'fleet.document.media-type': 'onboarding.errors.documentMediaType',
  'fleet.storage-unavailable': 'onboarding.errors.storage',
  'payouts.provider-unavailable': 'onboarding.waiting.payoutsUnavailable',
  'payouts.not-a-contractor': 'onboarding.waiting.payoutsUnavailable',
};

export function onboardingError(error: unknown): string {
  const key = error instanceof ApiError ? MESSAGES[error.code] : undefined;
  return key ? t(key) : errorMessage(error);
}
