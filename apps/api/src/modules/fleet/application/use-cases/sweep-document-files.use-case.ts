import { err, ok, type CallContext, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { isSystem } from '../access';
import { documentPrefix } from '../document-files';
import { forbidden, type FleetFailure } from '../failure';
import type { FleetDependencies } from '../fleet-dependencies';

/** Files one page of the listing holds; one run reads at most {@link MAX_SWEEP_PAGES} pages. */
export const SWEEP_PAGE = 500;
export const MAX_SWEEP_PAGES = 20;
/**
 * A file younger than this is left alone: a submission stores its file before its document row
 * commits, so a fresh file without a row may still be in flight.
 */
export const SWEEP_GRACE_MINUTES = 60;

export interface SweepOutcome {
  readonly checked: number;
  readonly removed: number;
}

/**
 * Removes stored courier document files that no document row names (security review L2): the
 * file of a submission whose row never committed, when removing it at once failed. Only keys
 * under the Market's `fleet/<market>/` prefix older than the grace period are touched. Safe to
 * run twice and concurrently. Rule `system`: run by the fleet's job only.
 *
 * The key holds the Market but not the tenant: while a Market has more than one tenant, a row
 * of another tenant would not be seen, so the sweep assumes one tenant per Market (today's
 * deployment).
 */
export class SweepDocumentFiles extends UseCase<Record<string, never>, SweepOutcome, FleetFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.sweep-document-files',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FleetDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<SweepOutcome, FleetFailure>> {
    if (!isSystem(context)) return err(forbidden());
    const { market } = context;
    const { files, couriers, unitOfWork, clock } = this.deps;
    const cutoff = clock.now().subtract({ minutes: SWEEP_GRACE_MINUTES });
    const total = { checked: 0, removed: 0 };
    let after: string | undefined;
    for (let page = 0; page < MAX_SWEEP_PAGES; page += 1) {
      const listed = await files.list(documentPrefix(market.marketId), SWEEP_PAGE, after);
      if (listed.length === 0) break;
      after = listed[listed.length - 1]!.key;
      const old = listed.filter((o) => o.writtenAt.epochMilliseconds < cutoff.epochMilliseconds);
      total.checked += listed.length;
      if (old.length > 0) {
        const named = await unitOfWork.run(
          market,
          async () =>
            ok(
              await couriers.namedFileKeys(
                market,
                old.map((o) => o.key),
              ),
            ),
          { readOnly: true },
        );
        if (!named.ok) break;
        for (const { key } of old) {
          if (named.value.has(key)) continue;
          await files.delete(key);
          total.removed += 1;
        }
      }
      if (listed.length < SWEEP_PAGE) break;
    }
    return ok(total);
  }
}
