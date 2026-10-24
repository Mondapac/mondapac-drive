import { Badge, type BadgeTone } from '../form/badge.tsx';

export interface LedgerTotalItem {
  readonly id: string;
  readonly label: string;
  /** The amount, already formatted for the reader. */
  readonly value: string;
  /** The closing figure (balance) is set apart. */
  readonly emphasis?: boolean;
}

/** Totals as tiles: two per row on phones, one row from the large breakpoint. */
export function LedgerTotals({ items }: { readonly items: readonly LedgerTotalItem[] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.id}
          // Every tile has the same fill; the closing figure is set apart by a stronger border
          // and a label in the body colour.
          className={`min-w-0 rounded-lg border bg-surface p-3 ${
            item.emphasis === true ? 'border-line-control' : 'border-line'
          }`}
        >
          <dt
            className={`text-sm ${item.emphasis === true ? 'font-medium text-fg' : 'text-fg-muted'}`}
          >
            {item.label}
          </dt>
          <dd className="mt-1 break-words text-lg font-semibold tabular-nums text-fg">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface LedgerRow {
  readonly id: string;
  /** ISO instant for the `<time>` element. */
  readonly dateTime: string;
  readonly when: string;
  readonly order: string;
  /** Full id, shown as the tooltip of the short order reference. */
  readonly orderTitle?: string;
  readonly kind: string;
  readonly kindTone: BadgeTone;
  /** The amount, already formatted, with its sign. */
  readonly amount: string;
}

export interface LedgerTableLabels {
  readonly caption: string;
  readonly when: string;
  readonly order: string;
  readonly kind: string;
  readonly amount: string;
}

/**
 * A ledger as a table: date, order, kind, amount. The amount column is end-aligned (header and
 * cells alike) and tabular; the table scrolls inside its own box on narrow screens.
 */
export function LedgerTable({
  rows,
  labels,
}: {
  readonly rows: readonly LedgerRow[];
  readonly labels: LedgerTableLabels;
}) {
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-start sm:min-w-120 text-sm">
        <caption className="sr-only">{labels.caption}</caption>
        <thead className="bg-muted text-fg-muted">
          <tr>
            <th scope="col" className="whitespace-nowrap px-2 py-3 sm:px-3 font-medium">
              {labels.when}
            </th>
            <th
              scope="col"
              className="hidden whitespace-nowrap px-2 py-3 sm:px-3 font-medium sm:table-cell"
            >
              {labels.order}
            </th>
            <th scope="col" className="whitespace-nowrap px-2 py-3 sm:px-3 font-medium">
              {labels.kind}
            </th>
            <th scope="col" className="whitespace-nowrap px-2 py-3 sm:px-3 text-end font-medium">
              {labels.amount}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-row">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-2 py-3 sm:whitespace-nowrap sm:px-3">
                <time dateTime={row.dateTime}>{row.when}</time>
                {/* The Order column is hidden on phones; its reference moves under the date. */}
                <span className="block text-xs text-fg-muted sm:hidden" title={row.orderTitle}>
                  {row.order}
                </span>
              </td>
              <td
                className="hidden whitespace-nowrap px-2 py-3 sm:px-3 font-medium text-fg sm:table-cell"
                title={row.orderTitle}
              >
                {row.order}
              </td>
              <td className="whitespace-nowrap px-2 py-3 sm:px-3">
                <Badge tone={row.kindTone}>{row.kind}</Badge>
              </td>
              <td className="whitespace-nowrap px-2 py-3 sm:px-3 text-end tabular-nums">
                {row.amount}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
