import { Badge, type BadgeTone } from '@mondapac-drive/ui';
import type { DeliveryStatus } from '../ops/types.ts';

const TONE: Readonly<Record<DeliveryStatus, BadgeTone>> = {
  SCHEDULED: 'neutral',
  DISPATCHING: 'attention',
  ASSIGNED: 'info',
  AT_PICKUP: 'info',
  PICKED_UP: 'info',
  AT_DROPOFF: 'info',
  DELIVERED: 'success',
  DELIVERY_FAILED: 'critical',
  RETURNING: 'attention',
  RETURNED: 'neutral',
  CANCELLED: 'neutral',
};

/** A delivery's status; "Finding a courier" stands out, as it is what a dispatcher acts on. */
export function DeliveryStatusBadge({
  status,
  label,
}: {
  readonly status: DeliveryStatus;
  readonly label: string;
}) {
  return <Badge tone={TONE[status] ?? 'neutral'}>{label}</Badge>;
}
