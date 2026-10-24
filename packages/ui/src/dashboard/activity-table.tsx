import type { ReactNode } from 'react';
import { CARD_TABLE } from '../data/card-table.ts';

export interface ActivityColumn<Row> {
  readonly id: string;
  readonly header: string;
  /**
   * `title`: the first cell, which is the card's title on a phone and takes the width that is
   * left; `corner`: sits beside the title on a phone (a status); `labelled`: a line with its
   * column name on a phone.
   */
  readonly kind: 'title' | 'corner' | 'labelled';
  /**
   * The width of the column from 1024 px, from one shared set so the tables of sibling cards
   * line up: `status` (a badge), `text` (a short label), `figure` (a number or amount, set with
   * `align: 'end'`), `date` and `zoned-date` (a date and time with the zone name, which needs
   * more room). The title column has none and takes what is left.
   */
  readonly size?: 'status' | 'text' | 'figure' | 'date' | 'zoned-date';
  readonly align?: 'start' | 'end';
  readonly cell: (row: Row) => ReactNode;
}

const SIZE = {
  status: 'w-44',
  text: 'w-44',
  figure: 'w-40',
  date: 'w-40',
  'zoned-date': 'w-48',
} as const;

/**
 * The latest rows of something, in a dashboard card: a table from 1024 px, a stack of labelled
 * cards below (CARD_TABLE). Columns have set widths so tables of sibling cards line up, and each
 * header sits where its cells start (or end, for figures).
 */
export function ActivityTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
}: {
  readonly caption: string;
  readonly columns: readonly ActivityColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
}) {
  return (
    <table className={`${CARD_TABLE.table} lg:table-fixed`}>
      <caption className="sr-only">{caption}</caption>
      <colgroup className="max-lg:hidden">
        {columns.map((column) => (
          <col
            key={column.id}
            className={column.size === undefined ? undefined : SIZE[column.size]}
          />
        ))}
      </colgroup>
      <thead className={CARD_TABLE.head}>
        <tr>
          {columns.map((column) => (
            <th
              key={column.id}
              scope="col"
              className={`px-4 py-3 font-medium ${column.align === 'end' ? 'text-end' : ''}`}
            >
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className={`${CARD_TABLE.body} border-t border-line-row`}>
        {rows.map((row) => (
          <tr key={rowKey(row)} className={CARD_TABLE.row}>
            {columns.map((column) => (
              <td
                key={column.id}
                data-label={column.kind === 'labelled' ? column.header : undefined}
                className={`${CARD_TABLE[column.kind === 'title' ? 'cell' : column.kind]} ${
                  column.align === 'end' ? 'lg:text-end' : ''
                } break-words`}
              >
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A count of a list that may have more pages: the exact figure, or "25+" when the page was full
 * and more exist. Never a wrong exact number.
 */
export function formatCount(count: number, hasMore: boolean, locale: string): string {
  const text = new Intl.NumberFormat(locale).format(count);
  return hasMore ? `${text}+` : text;
}
