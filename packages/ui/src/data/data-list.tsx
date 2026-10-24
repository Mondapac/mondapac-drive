import type { ReactNode } from 'react';

export interface DataListRow {
  readonly label: string;
  /** null shows the DataRow Missing state: the list's `missing` text, muted. */
  readonly value: ReactNode | null;
  /** `totals` only: the closing row (the total), set apart by a rule and a heavier weight. */
  readonly emphasis?: boolean;
}

export type DataListVariant = 'default' | 'stacked' | 'totals';

/**
 * Label and value pairs (Figma DataRow). Variants:
 * - `default`: every list shares one label column width (--mp-size-data-label), so sibling cards
 *   on a page line up; on a phone the label sits above its value.
 * - `stacked`: the label always sits above its value, for a narrow column (a side card).
 * - `totals`: money rows, label on the left and the amount end-aligned; the `emphasis` row (the
 *   total) is set apart by a rule.
 */
export function DataList({
  rows,
  missing,
  variant = 'default',
}: {
  readonly rows: readonly DataListRow[];
  /** Shown for a row without a value, such as "Not given". */
  readonly missing: string;
  readonly variant?: DataListVariant;
}) {
  if (variant === 'totals') {
    return (
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 text-sm">
        {rows.map((row) =>
          row.emphasis === true ? (
            <div
              key={row.label}
              className="col-span-2 flex justify-between gap-3 border-t border-line pt-3 font-semibold text-fg"
            >
              <dt>{row.label}</dt>
              <dd className="text-end tabular-nums">{row.value}</dd>
            </div>
          ) : (
            <div key={row.label} className="contents">
              <dt className="text-fg-muted">{row.label}</dt>
              <dd className="text-end tabular-nums">{row.value}</dd>
            </div>
          ),
        )}
      </dl>
    );
  }
  const stacked = variant === 'stacked';
  return (
    <dl
      className={
        stacked
          ? 'grid gap-y-3'
          : 'grid gap-x-6 gap-y-1 sm:grid-cols-[minmax(0,var(--mp-size-data-label))_minmax(0,1fr)] sm:gap-y-3'
      }
    >
      {rows.map((row) => (
        <div key={row.label} className={stacked ? 'grid gap-y-1' : 'contents'}>
          <dt className="text-fg-muted">{row.label}</dt>
          <dd
            className={`whitespace-pre-line break-words font-medium text-fg ${stacked ? '' : 'max-sm:mb-3'}`}
          >
            {row.value === null ? (
              <span className="font-normal text-fg-muted">{missing}</span>
            ) : (
              row.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
