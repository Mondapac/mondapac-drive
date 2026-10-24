import type { Provider } from '@nestjs/common';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  NOTIFICATION_SETTINGS,
  OUTBOUND_REPOSITORY,
  RECIPIENT_DIRECTORY,
  SMS_SENDER,
  TRACKING_LINKS,
  WEBHOOK_SIGNER,
  WEBHOOK_SUBSCRIPTIONS,
  WEBHOOK_TRANSPORT,
} from '../application/ports';
import { ConfigNotificationSettingsProvider } from './config-notification-settings.provider';
import { HmacWebhookSigner } from './hmac-webhook-signer';
import { HttpsWebhookTransport } from './https-webhook-transport';
import { twilioCredentials, webhookKey } from './notifications-secrets';
import { NoRecipientDirectory, NoTrackingLinks } from './pending-integrations';
import {
  PrismaOutboundRepository,
  PrismaWebhookSubscriptionRepository,
} from './prisma-notifications.repository';
import { TwilioSmsSender, UnconfiguredSmsSender } from './twilio-sms-sender';

/** The implementations of the notifications ports. Only infrastructure/ reaches the platform internals. */
export const notificationsProviders: Provider[] = [
  {
    provide: WEBHOOK_SUBSCRIPTIONS,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService) => new PrismaWebhookSubscriptionRepository(prisma),
  },
  {
    provide: OUTBOUND_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService) => new PrismaOutboundRepository(prisma),
  },
  {
    provide: NOTIFICATION_SETTINGS,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry) => new ConfigNotificationSettingsProvider(markets),
  },
  {
    provide: WEBHOOK_SIGNER,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => new HmacWebhookSigner(webhookKey(process.env, config)),
  },
  { provide: WEBHOOK_TRANSPORT, useValue: new HttpsWebhookTransport() },
  {
    provide: SMS_SENDER,
    useFactory: () => {
      const credentials = twilioCredentials(process.env);
      return credentials === null ? new UnconfiguredSmsSender() : new TwilioSmsSender(credentials);
    },
  },
  { provide: RECIPIENT_DIRECTORY, useValue: new NoRecipientDirectory() },
  { provide: TRACKING_LINKS, useValue: new NoTrackingLinks() },
];
