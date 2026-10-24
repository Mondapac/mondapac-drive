/**
 * Class names for a list table that becomes a stack of cards below 1024 px, where its columns do
 * not fit (Team, Roles, Sellers, Offers, Products, Orders). The first cell is the card's title; a
 * `corner` cell (a status) sits beside it; every other cell is a `labelled` line that shows its
 * column name from `data-label` on the same line as its value (a 7rem label column on phones,
 * the DataRow label column --mp-size-data-label from 640 px), so a card stays short.
 */
export const CARD_TABLE = {
  table: 'w-full text-start text-sm max-lg:block',
  head: 'bg-muted text-fg-muted max-lg:sr-only',
  body: 'divide-y divide-line-row max-lg:block',
  row: 'max-lg:grid max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:items-start max-lg:gap-x-3 max-lg:gap-y-1 max-lg:p-4',
  cell: 'px-4 py-3 align-top max-lg:p-0 max-lg:pb-1',
  corner: 'px-4 py-3 align-top max-lg:col-start-2 max-lg:row-start-1 max-lg:p-0 max-lg:text-end',
  labelled:
    'px-4 py-3 align-top max-lg:col-span-2 max-lg:grid max-lg:grid-cols-[minmax(0,7rem)_minmax(0,1fr)] max-lg:items-baseline max-lg:justify-items-start max-lg:gap-x-2 max-lg:[&>*]:col-start-2 max-lg:p-0 max-lg:before:text-fg-muted max-lg:before:content-[attr(data-label)] sm:max-lg:grid-cols-[var(--mp-size-data-label)_minmax(0,1fr)]',
} as const;
