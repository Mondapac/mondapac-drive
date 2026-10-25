import type { MarketId } from '@mondapac-drive/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { NotificationSettings, NotificationSettingsProvider } from '../application/ports';

/**
 * The `notifications` section of each hosted Market file, validated at start-up, and the courier
 * session lifetime of its `identity` section, which bounds a push device's.
 */
export class ConfigNotificationSettingsProvider implements NotificationSettingsProvider {
  constructor(private readonly markets: MarketRegistry) {}

  get(marketId: MarketId): NotificationSettings {
    const { notifications, identity } = this.markets.get(marketId);
    const { webhooks, sms, push } = notifications;
    const { rotationOverlapMinutes, ...webhookRetry } = webhooks;
    // A Market without courier sessions has no courier to register a device; a day bounds it.
    const sessionMinutes = identity.sessions.courier?.absoluteLifetimeMinutes ?? 24 * 60;
    return {
      webhookRetry,
      rotationOverlapSeconds: rotationOverlapMinutes * 60,
      sms,
      offerPush: { title: push.offerTitle, body: push.offerBody },
      pushDeviceLifetimeSeconds: sessionMinutes * 60,
    };
  }
}
