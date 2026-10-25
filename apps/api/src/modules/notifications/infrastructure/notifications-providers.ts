import { Logger, type Provider } from '@nestjs/common';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { DeliveryRecipients, DeliveryReferences } from '../../delivery';
import { IDENTITY_FACADE, type IdentityFacade } from '../../identity';
import { IssueTrackingLink } from '../../tracking';
import {
  COURIER_SESSIONS,
  DELIVERY_CONTACTS,
  NOTIFICATION_SETTINGS,
  OUTBOUND_REPOSITORY,
  PUSH_DEVICES,
  PUSH_SENDER,
  SMS_SENDER,
  TRACKING_LINKS,
  WEBHOOK_SIGNER,
  WEBHOOK_SUBSCRIPTIONS,
  WEBHOOK_TRANSPORT,
} from '../application/ports';
import { ConfigNotificationSettingsProvider } from './config-notification-settings.provider';
import { HmacWebhookSigner } from './hmac-webhook-signer';
import { HttpsWebhookTransport } from './https-webhook-transport';
import { ExpoPushSender, DisabledPushSender } from './expo-push-sender';
import { expoAccessToken, twilioCredentials, webhookKey } from './notifications-secrets';
import { DeliveryRecipientContacts } from './delivery-contacts';
import { IdentityCourierSessions } from './identity-courier-sessions';
import {
  PrismaOutboundRepository,
  PrismaWebhookSubscriptionRepository,
} from './prisma-notifications.repository';
import { PrismaPushDeviceRepository } from './prisma-push-devices.repository';
import { PushTokenSeal } from './push-token-seal';
import { IssuedTrackingLinks } from './tracking-links';
import { TwilioSmsSender, UnconfiguredSmsSender } from './twilio-sms-sender';

/** The deployment's notifications key, read once: it signs webhooks and seals push tokens. */
const NOTIFICATIONS_KEY = Symbol('NotificationsKey');

/** The implementations of the notifications ports. Only infrastructure/ reaches the platform internals. */
export const notificationsProviders: Provider[] = [
  {
    provide: NOTIFICATIONS_KEY,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => webhookKey(process.env, config),
  },
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
    inject: [NOTIFICATIONS_KEY],
    useFactory: (key: Uint8Array) => new HmacWebhookSigner(key),
  },
  {
    provide: PUSH_DEVICES,
    inject: [PrismaService, NOTIFICATIONS_KEY],
    useFactory: (prisma: PrismaService, key: Uint8Array) =>
      new PrismaPushDeviceRepository(prisma, new PushTokenSeal(key)),
  },
  {
    provide: COURIER_SESSIONS,
    inject: [IDENTITY_FACADE],
    useFactory: (identity: IdentityFacade) => new IdentityCourierSessions(identity),
  },
  {
    provide: PUSH_SENDER,
    useFactory: () => {
      const token = expoAccessToken(process.env);
      if (token !== null) return new ExpoPushSender(token);
      new Logger('NotificationsPush').warn({
        msg: 'notifications.push.disabled',
        note: 'EXPO_ACCESS_TOKEN is not set: no offer push is sent',
      });
      return new DisabledPushSender();
    },
  },
  { provide: WEBHOOK_TRANSPORT, useValue: new HttpsWebhookTransport() },
  {
    provide: SMS_SENDER,
    useFactory: () => {
      const credentials = twilioCredentials(process.env);
      return credentials === null ? new UnconfiguredSmsSender() : new TwilioSmsSender(credentials);
    },
  },
  {
    provide: DELIVERY_CONTACTS,
    inject: [DeliveryRecipients, DeliveryReferences],
    useFactory: (recipients: DeliveryRecipients, references: DeliveryReferences) =>
      new DeliveryRecipientContacts(recipients, references),
  },
  {
    provide: TRACKING_LINKS,
    inject: [IssueTrackingLink],
    useFactory: (issue: IssueTrackingLink) => new IssuedTrackingLinks(issue),
  },
];
