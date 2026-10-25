import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import {
  ChangeWebhookEventTypes,
  DisableWebhookSubscription,
  ListWebhookSubscriptions,
  RotateWebhookSecret,
} from '../application/use-cases/change-webhook-subscription.use-case';
import {
  ListDeadWebhookCalls,
  ResendWebhookCall,
  type WebhookCall,
} from '../application/use-cases/resend-webhook-call.use-case';
import {
  RegisterPushDevice,
  RemovePushDevice,
} from '../application/use-cases/push-devices.use-case';
import {
  SubscribeToWebhooks,
  type SubscriptionWithSecret,
} from '../application/use-cases/subscribe-to-webhooks.use-case';
import type { WebhookSubscription } from '../domain/webhook-subscription';
import { answer, parsed, pathId } from './notifications-http';
import { eventTypesBody, pushDeviceBody, subscribeBody } from './notifications.schemas';

/** A subscription as its merchant sees it: never a secret. */
const subscriptionBody = (subscription: WebhookSubscription) => ({
  id: subscription.id,
  url: subscription.url,
  eventTypes: subscription.eventTypes,
  status: subscription.status,
  secretVersion: subscription.secretVersion,
  previousSecretValidUntil: subscription.previousSecretValidUntil?.toString() ?? null,
  createdAt: subscription.createdAt.toString(),
});

/** The one answer that carries a secret: after subscribing or rotating. */
const withSecretBody = ({ subscription, secret }: SubscriptionWithSecret) => ({
  ...subscriptionBody(subscription),
  secret,
});

/** A dead call as an operator sees it: ids, codes and times; not its body. */
const callBody = (call: WebhookCall) => ({
  id: call.id,
  subscriptionId: call.subscriptionId,
  eventId: call.eventId,
  eventType: call.eventType,
  status: call.status,
  attempts: call.attempts,
  lastStatusCode: call.lastStatusCode,
  lastErrorCode: call.lastErrorCode,
  createdAt: call.createdAt.toString(),
  deadAt: call.deadAt?.toString() ?? null,
  nextAttemptAt: call.nextAttemptAt?.toString() ?? null,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };

/**
 * The merchant's webhook API (`Authorization: Bearer <merchant API key>`, `x-market-id`): the
 * merchant subscribes endpoints to its deliveries' events, lists and changes them, rotates a
 * signing secret and disables a subscription. The merchant is always the key's; another
 * merchant's subscription answers 404 as a missing one. Every change is audited.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@RoutePopulation('merchant')
@Controller('notifications/webhook-subscriptions')
export class MerchantWebhookController {
  constructor(
    private readonly subscribe: SubscribeToWebhooks,
    private readonly list: ListWebhookSubscriptions,
    private readonly changeEventTypes: ChangeWebhookEventTypes,
    private readonly rotateSecret: RotateWebhookSecret,
    private readonly disable: DisableWebhookSubscription,
  ) {}

  @Post()
  @ReadsSession()
  @ApiOperation({
    summary: 'Subscribe an HTTPS endpoint to delivery events',
    description:
      'Answers the signing secret once; it is never shown again. The URL must be public HTTPS ' +
      'without credentials (checked again at every send).',
  })
  async create(@Call() context: CallContext, @Body() body: unknown) {
    const input = parsed(() => subscribeBody.parse(body));
    return withSecretBody(answer(await this.subscribe.execute(context, input)));
  }

  @Get()
  @ReadsSession()
  @ApiOperation({ summary: "The merchant's subscriptions, newest first, without secrets" })
  async index(@Call() context: CallContext) {
    const subscriptions = answer(await this.list.execute(context, {}));
    return { subscriptions: subscriptions.map(subscriptionBody) };
  }

  @Put(':id/event-types')
  @ReadsSession()
  @ApiOperation({ summary: 'Change which delivery events a subscription receives' })
  async events(@Call() context: CallContext, @Param('id') id: string, @Body() body: unknown) {
    const subscriptionId = pathId(id, 'webhook-subscription');
    const { eventTypes } = parsed(() => eventTypesBody.parse(body));
    return subscriptionBody(
      answer(await this.changeEventTypes.execute(context, { subscriptionId, eventTypes })),
    );
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "Rotate a subscription's signing secret",
    description:
      'Answers the new secret once. Calls carry both signatures (two `v1=` entries) until ' +
      '`previousSecretValidUntil`, then only the new one.',
  })
  async rotate(@Call() context: CallContext, @Param('id') id: string) {
    const subscriptionId = pathId(id, 'webhook-subscription');
    return withSecretBody(answer(await this.rotateSecret.execute(context, { subscriptionId })));
  }

  @Post(':id/disable')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({ summary: 'Disable a subscription: no new calls; queued ones are dropped' })
  async off(@Call() context: CallContext, @Param('id') id: string) {
    const subscriptionId = pathId(id, 'webhook-subscription');
    return subscriptionBody(answer(await this.disable.execute(context, { subscriptionId })));
  }
}

/**
 * The admin panel's webhook operations (the admin session cookie; an unsafe method needs the
 * CSRF token): the dead-lettered calls of the Market, and sending one again. Rule `permissions
 * [notifications.webhook-call.resend]`; the re-send is audited.
 */
@ApiTags('notifications')
@RoutePopulation('admin')
@Controller('notifications/admin/webhook-calls')
export class AdminWebhookCallController {
  constructor(
    private readonly deadCalls: ListDeadWebhookCalls,
    private readonly resend: ResendWebhookCall,
  ) {}

  @Get('dead')
  @ReadsSession()
  @ApiOperation({ summary: 'Dead-lettered webhook calls, the most recently dead first' })
  async dead(@Call() context: CallContext) {
    return { calls: answer(await this.deadCalls.execute(context, {})).map(callBody) };
  }

  @Post(':id/resend')
  @HttpCode(200)
  @ReadsSession()
  @ApiHeader(CSRF)
  @ApiOperation({ summary: 'Send a dead-lettered call again, with the same body and event id' })
  async again(@Call() context: CallContext, @Param('id') id: string) {
    const callId = pathId(id, 'webhook-call');
    return callBody(answer(await this.resend.execute(context, { callId })));
  }
}

/**
 * The courier app's push device (`Authorization: Bearer <session token>`): the app registers the
 * Expo push token of its session after sign-in and at each start, and drops it on sign-out. The
 * courier and the session are the token's, never a path or body field. The token is sealed at
 * rest and never answered. A new offer then reaches the phone as "New offer, expires in N s",
 * carrying the offer id only.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@RoutePopulation('courier')
@Controller('notifications/courier/me/push-device')
export class CourierPushDeviceController {
  constructor(
    private readonly register: RegisterPushDevice,
    private readonly remove: RemovePushDevice,
  ) {}

  @Put()
  @HttpCode(204)
  @ReadsSession()
  @ApiOperation({
    summary: "Register this session's push device",
    description:
      'Replaces the device this session registered before; a token another session held moves ' +
      'here. 400 `push-device.invalid-token` when the token is not an Expo push token.',
  })
  async put(@Call() context: CallContext, @Body() body: unknown): Promise<void> {
    const input = parsed(() => pushDeviceBody.parse(body));
    answer(await this.register.execute(context, input));
  }

  @Delete()
  @HttpCode(204)
  @ReadsSession()
  @ApiOperation({ summary: "Drop this session's push device (on sign-out)" })
  async drop(@Call() context: CallContext): Promise<void> {
    answer(await this.remove.execute(context, {}));
  }
}
