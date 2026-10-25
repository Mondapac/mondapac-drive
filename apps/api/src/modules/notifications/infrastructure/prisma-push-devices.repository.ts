import { Temporal, type MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { PushDeviceRepository } from '../application/ports';
import type { PushDevice, PushPlatform } from '../domain/push-device';
import type { PushTokenSeal } from './push-token-seal';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const scope = (market: MarketContext) => ({
  marketId: market.marketId,
  tenantId: market.tenantId,
});

/**
 * Courier push devices in `notifications.push_devices`. The token is stored sealed (AES-GCM,
 * bound to the account) next to its keyed digest, which is unique per Market so that one phone
 * belongs to one session. A row that no longer opens (the notifications key was rotated) is
 * skipped as if absent; the app registers again.
 */
export class PrismaPushDeviceRepository implements PushDeviceRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seal: PushTokenSeal,
  ) {}

  async save(market: MarketContext, device: PushDevice): Promise<void> {
    const tokenLookup = this.seal.lookup(device.token);
    const db = this.prisma.tx(market);
    await db.notificationsPushDevice.deleteMany({
      where: { ...scope(market), OR: [{ sessionId: device.sessionId }, { tokenLookup }] },
    });
    await db.notificationsPushDevice.create({
      data: {
        ...scope(market),
        id: device.id,
        accountId: device.accountId,
        sessionId: device.sessionId,
        platform: device.platform,
        tokenSealed: this.seal.seal(device.token, device.accountId),
        tokenLookup,
        registeredAt: toDate(device.registeredAt),
        expiresAt: toDate(device.expiresAt),
      },
    });
  }

  async removeOfSession(market: MarketContext, accountId: string, sessionId: string) {
    const removed = await this.prisma.tx(market).notificationsPushDevice.deleteMany({
      where: { ...scope(market), accountId, sessionId },
    });
    return removed.count;
  }

  async removeOfAccount(market: MarketContext, accountId: string) {
    const removed = await this.prisma.tx(market).notificationsPushDevice.deleteMany({
      where: { ...scope(market), accountId },
    });
    return removed.count;
  }

  async removeByIds(market: MarketContext, ids: readonly string[]) {
    if (ids.length === 0) return 0;
    const removed = await this.prisma.tx(market).notificationsPushDevice.deleteMany({
      where: { ...scope(market), id: { in: [...ids] } },
    });
    return removed.count;
  }

  async liveOf(market: MarketContext, accountId: string, now: Temporal.Instant, limit: number) {
    const rows = await this.prisma.tx(market).notificationsPushDevice.findMany({
      where: { ...scope(market), accountId, expiresAt: { gt: toDate(now) } },
      orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const devices: PushDevice[] = [];
    for (const row of rows) {
      let token;
      try {
        token = this.seal.open(row.tokenSealed, row.accountId);
      } catch {
        continue;
      }
      devices.push({
        id: row.id,
        accountId: row.accountId,
        sessionId: row.sessionId,
        platform: row.platform as PushPlatform,
        token,
        registeredAt: toInstant(row.registeredAt),
        expiresAt: toInstant(row.expiresAt),
      });
    }
    return devices;
  }
}
