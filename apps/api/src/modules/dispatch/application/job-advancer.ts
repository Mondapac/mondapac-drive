import { Inject, Injectable } from '@nestjs/common';
import {
  ok,
  type CallContext,
  type Clock,
  type Id,
  type IdGenerator,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../platform/clock/clock.module';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  couriersNotToOffer,
  sendWave,
  sweep,
  type DispatchJob,
  type JobChange,
} from '../domain/dispatch-job';
import type { DispatchSettings } from '../domain/dispatch-settings';
import { rankCandidates, type RankedCandidate } from '../domain/matching';
import {
  COURIER_AVAILABILITY,
  COURIER_PROXIMITY,
  DISPATCH_JOB_REPOSITORY,
  DISPATCH_SETTINGS,
  type CourierAvailability,
  type CourierProximity,
  type DispatchJobRepository,
  type DispatchSettingsProvider,
} from './ports';

/** What advancing one job did. */
export type Advanced = 'unchanged' | 'advanced' | 'stale';

/**
 * Moves one job forward in time: opens it, expires offers, sends the next wave or exhausts it
 * (domain `sweep` and `sendWave`). Candidates are read before the unit opens, since they come
 * from other modules; the unit reloads the job and applies the change to what it finds. Run by
 * the system actor only (the sweep and the event subscribers): fleet and tracking are asked as
 * the system.
 */
@Injectable()
export class JobAdvancer {
  constructor(
    @Inject(DISPATCH_JOB_REPOSITORY) private readonly jobs: DispatchJobRepository,
    @Inject(DISPATCH_SETTINGS) private readonly settings: DispatchSettingsProvider,
    @Inject(COURIER_AVAILABILITY) private readonly availability: CourierAvailability,
    @Inject(COURIER_PROXIMITY) private readonly proximity: CourierProximity,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async advance(context: CallContext, jobId: Id<'DispatchJob'>): Promise<Advanced> {
    const { market } = context;
    const settings = this.settings.get(market.marketId);
    const now = this.clock.now();

    const read = await this.unitOfWork.run(
      market,
      async () => ok(await this.jobs.findById(market, jobId)),
      { readOnly: true },
    );
    const before = read.ok ? read.value : undefined;
    if (before === undefined) return 'unchanged';
    const preview = sweep(before, now, settings);
    if (!preview.changed && !preview.waveDue) return 'unchanged';
    const candidates = preview.waveDue
      ? await this.candidatesFor(context, preview.job, settings)
      : undefined;

    try {
      const saved = await this.unitOfWork.run(market, async () => {
        const job = await this.jobs.findById(market, jobId);
        if (job === undefined) return ok(false);
        const swept = sweep(job, now, settings);
        let change: JobChange = swept;
        // A wave found due only now (a race with an answer) waits for the next sweep.
        if (swept.waveDue && candidates !== undefined) {
          const wave = sendWave(swept.job, candidates, now, settings, () =>
            this.ids.next<'DispatchOffer'>(),
          );
          // One saved change, one version step, however many steps the domain took.
          change = {
            job: { ...wave.job, version: job.version + 1 },
            events: [...swept.events, ...wave.events],
          };
        }
        if (change.job.version === job.version) return ok(false);
        await this.jobs.update(market, change.job);
        if (change.events.length > 0) await this.outbox.append(context, change.events);
        return ok(true);
      });
      return saved.ok && saved.value ? 'advanced' : 'unchanged';
    } catch (error) {
      if (error instanceof StaleAggregateError) return 'stale';
      throw error;
    }
  }

  private async candidatesFor(
    context: CallContext,
    job: DispatchJob,
    settings: DispatchSettings,
  ): Promise<RankedCandidate[]> {
    const needs = job.requirements;
    const [available, nearby] = await Promise.all([
      this.availability.findEligibleCouriers(context, needs),
      this.proximity.nearestCouriers(context, needs.pickup, {
        radiusMetres: settings.searchRadiusMetres,
        limit: settings.candidateLimit,
        serviceArea: needs.serviceAreaCode,
      }),
    ]);
    return rankCandidates(needs, available, nearby, {
      searchRadiusMetres: settings.searchRadiusMetres,
      exclude: couriersNotToOffer(job),
    });
  }
}
