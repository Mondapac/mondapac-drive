import type { VehicleType } from '../../api/schemas';
import { t, type TranslationKey } from '../../i18n';
import { humanise } from './onboarding-steps';

/** Copy for a Market code (document type, rejection reason): the translation, else the code. */
function copyOr(key: string, code: string): string {
  const text = t(key as TranslationKey);
  return text === key ? humanise(code) : text;
}

export const documentLabel = (type: string) => copyOr(`onboarding.documents.types.${type}`, type);

export const reasonLabel = (reason: string) =>
  copyOr(`onboarding.documents.reasons.${reason}`, reason);

/** Service areas are the Market's codes; the app shows them as words. */
export const areaLabel = (code: string) => humanise(code);

export const vehicleLabel = (type: VehicleType) => t(`onboarding.vehicle.types.${type}`);
