import 'server-only';
import { serverGet, type ServerGet } from '../server/server-fetch.ts';
import type { Delivery, DeliveryPage, DeliverySummary } from '../ops/types.ts';
import { exceptionOf, MAP_STATUSES, roundPoint, type MapDelivery } from './model.ts';

/** The newest deliveries the map reads in one page, and the details it may read for points. */
export const MAP_PAGE = 100;
const MAX_DETAIL_READS = 50;
const DETAIL_BATCH = 10;

/**
 * A summary's points: its own when the delivery API sends them (handoff 21), else the stops of
 * the delivery's detail, of which only the two points are kept; the addresses and contacts of the
 * detail never leave the page server.
 */
async function pointsOf(
  summaries: readonly DeliverySummary[],
): Promise<ReadonlyMap<string, Pick<MapDelivery, 'pickup' | 'dropoff'>>> {
  const points = new Map<string, Pick<MapDelivery, 'pickup' | 'dropoff'>>();
  const missing: string[] = [];
  // Exceptions first, so a busy Market never leaves one without its pin.
  const flaggedFirst = [...summaries].sort(
    (a, b) =>
      Number(exceptionOf(b.status, b.exception) !== null) -
      Number(exceptionOf(a.status, a.exception) !== null),
  );
  for (const row of flaggedFirst) {
    if (row.pickupPoint !== undefined && row.dropoffPoint !== undefined) {
      points.set(row.id, {
        pickup: roundPoint(row.pickupPoint),
        dropoff: roundPoint(row.dropoffPoint),
      });
    } else if (missing.length < MAX_DETAIL_READS) {
      missing.push(row.id);
    }
  }
  for (let start = 0; start < missing.length; start += DETAIL_BATCH) {
    const batch = missing.slice(start, start + DETAIL_BATCH);
    const details = await Promise.all(
      batch.map((id) => serverGet<Delivery>(`delivery/admin/deliveries/${id}`)),
    );
    details.forEach((answer, index) => {
      if (answer.kind !== 'ok') return;
      points.set(batch[index] as string, {
        pickup: roundPoint(answer.body.pickup.point),
        dropoff: roundPoint(answer.body.dropoff.point),
      });
    });
  }
  return points;
}

/** The deliveries the map shows, or the failed read of their list. */
export async function mapDeliveries(): Promise<
  | { readonly kind: 'ok'; readonly deliveries: readonly MapDelivery[] }
  | Exclude<ServerGet<never>, { kind: 'ok' }>
> {
  const list = await serverGet<DeliveryPage>(
    `delivery/admin/deliveries?status=${MAP_STATUSES.join(',')}&limit=${MAP_PAGE}`,
  );
  if (list.kind !== 'ok') return list;
  const points = await pointsOf(list.body.items);
  const deliveries: MapDelivery[] = [];
  for (const row of list.body.items) {
    const point = points.get(row.id) ?? { pickup: null, dropoff: null };
    deliveries.push({
      id: row.id,
      reference: row.externalReference,
      status: row.status,
      temperature: row.temperature,
      courierId: row.courierId ?? null,
      ...point,
      exception: exceptionOf(row.status, row.exception),
    });
  }
  return { kind: 'ok', deliveries };
}
