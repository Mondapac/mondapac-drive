import { Badge, Card, DataList, type BadgeTone } from '@mondapac-drive/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import type { Vehicle } from '../ops/types.ts';
import { formatInstant, shortInstant } from '../shared/format.ts';
import { offersByRound, type DispatchJob, type JobStatus, type SentOffer } from './dispatch-job.ts';
import { JobActions } from './job-actions.tsx';
import { shortId } from './names.ts';

const TONE: Readonly<Record<JobStatus, BadgeTone>> = {
  WAITING: 'neutral',
  OFFERING: 'info',
  ASSIGNED: 'success',
  EXHAUSTED: 'critical',
  COLLECTED: 'neutral',
  CANCELLED: 'neutral',
};

type Translate = Awaited<ReturnType<typeof getTranslations>>;

/** What happened to one offer, with the time it happened. */
function offerOutcome(t: Translate, offer: SentOffer, locale: string): string {
  const at = (iso: string | null) => (iso === null ? '' : shortInstant(iso, locale));
  switch (offer.status) {
    case 'PENDING':
      return t('job.offer.PENDING', { at: at(offer.expiresAt) });
    case 'EXPIRED':
      return t('job.offer.EXPIRED', { at: at(offer.expiresAt) });
    case 'ACCEPTED':
    case 'DECLINED':
      return t(`job.offer.${offer.status}`, { at: at(offer.answeredAt ?? offer.sentAt) });
    default:
      return offer.answeredAt === null
        ? t('job.offer.WITHDRAWN-plain')
        : t('job.offer.WITHDRAWN', { at: at(offer.answeredAt) });
  }
}

/**
 * The dispatch job of a delivery (`dispatch.job.view`): its status, the round it is in, when it
 * acts next, the assignment, and every round of offers with each courier's answer. With
 * `dispatch.job.assign` it also carries the assign and redispatch commands. Ids and codes only:
 * the addresses are on the delivery.
 */
export async function DispatchJobCard({
  job,
  couriers,
  activeCouriers,
  quotedVehicle,
  canAssign,
  csrfToken,
}: {
  readonly job: DispatchJob;
  /** Names of courier accounts the session may read. */
  readonly couriers: ReadonlyMap<string, string>;
  readonly activeCouriers: readonly { readonly accountId: string; readonly name: string }[];
  readonly quotedVehicle: Vehicle;
  readonly canAssign: boolean;
  readonly csrfToken: string;
}) {
  const t = await getTranslations('deliveries');
  const locale = await getLocale();
  const nameOf = (id: string) => couriers.get(id) ?? shortId(id);
  const { assignment } = job;
  const rounds = offersByRound(job.offers);
  return (
    <Card title={t('job.title')}>
      <div className="flex flex-col gap-4">
        <DataList
          variant="stacked"
          missing="-"
          rows={[
            {
              label: t('job.status'),
              value: (
                <Badge tone={TONE[job.status] ?? 'neutral'}>{t(`job.state.${job.status}`)}</Badge>
              ),
            },
            { label: t('job.round'), value: job.round === 0 ? null : String(job.round) },
            ...(job.status === 'WAITING'
              ? [{ label: t('job.opens'), value: formatInstant(job.opensAt, locale) }]
              : []),
            {
              label: t('job.next-action'),
              value: job.nextActionAt === null ? null : formatInstant(job.nextActionAt, locale),
            },
            {
              label: t('job.assignment'),
              value:
                assignment === null
                  ? t('detail.no-courier')
                  : t('job.assigned', {
                      name: nameOf(assignment.courierId),
                      vehicle: t(`vehicle.${assignment.vehicle}`),
                      method: t(`job.method.${assignment.method}`),
                      at: shortInstant(assignment.at, locale),
                    }),
            },
          ]}
        />
        {canAssign ? (
          <JobActions
            deliveryId={job.deliveryId}
            jobStatus={job.status}
            assigned={
              assignment === null
                ? null
                : { courierId: assignment.courierId, vehicle: assignment.vehicle }
            }
            quotedVehicle={quotedVehicle}
            couriers={activeCouriers}
            csrfToken={csrfToken}
          />
        ) : null}
        <section aria-labelledby={`offers-${job.id}`} className="flex flex-col gap-3">
          <h3 id={`offers-${job.id}`} className="text-sm font-semibold">
            {t('job.offers')}
          </h3>
          {rounds.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('job.no-offers')}</p>
          ) : (
            rounds.map(({ round, offers }) => (
              <div key={round} className="flex flex-col gap-1">
                <h4 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                  {t('job.round-n', { round })}
                </h4>
                <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
                  {offers.map((offer) => (
                    <li key={offer.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm">
                      <span className="break-words font-medium">
                        {nameOf(offer.courierId)} · {t(`vehicle.${offer.vehicle}`)}
                      </span>
                      <span className="text-fg-muted">
                        {t('job.sent', { at: shortInstant(offer.sentAt, locale) })} ·{' '}
                        {offerOutcome(t, offer, locale)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      </div>
    </Card>
  );
}
