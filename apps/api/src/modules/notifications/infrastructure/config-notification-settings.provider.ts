import type { MarketId } from '@mondapac-drive/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { NotificationSettings, NotificationSettingsProvider } from '../application/ports';

/** The `notifications` section of each hosted Market file, validated at start-up. */
export class ConfigNotificationSettingsProvider implements NotificationSettingsProvider {
  constructor(private readonly markets: MarketRegistry) {}

  get(marketId: MarketId): NotificationSettings {
    const { webhooks, sms } = this.markets.get(marketId).notifications;
    const { rotationOverlapMinutes, ...webhookRetry } = webhooks;
    return { webhookRetry, rotationOverlapSeconds: rotationOverlapMinutes * 60, sms };
  }
}
