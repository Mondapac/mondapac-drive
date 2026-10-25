import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES } from '../domain/delivery-change';
import { PUSH_PLATFORMS } from '../domain/push-device';

const eventTypes = z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length);

/** A new subscription: the HTTPS endpoint (checked again by the SSRF guard) and its events. */
export const subscribeBody = z.strictObject({
  url: z.string().min(1).max(2048),
  eventTypes,
});

/** The event types a subscription receives from now on. */
export const eventTypesBody = z.strictObject({ eventTypes });

/** The courier session's push device: its Expo token (format checked by the use case). */
export const pushDeviceBody = z.strictObject({
  token: z.string().min(1).max(200),
  platform: z.enum(PUSH_PLATFORMS),
});
