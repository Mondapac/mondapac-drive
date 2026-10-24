import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityTable, formatCount, type ActivityColumn } from './activity-table.tsx';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly total: string;
}

const columns: ActivityColumn<Row>[] = [
  { id: 'name', header: 'Name', kind: 'title', cell: (r) => r.name },
  { id: 'status', header: 'Status', kind: 'corner', size: 'status', cell: (r) => r.status },
  {
    id: 'total',
    header: 'Total',
    kind: 'labelled',
    size: 'figure',
    align: 'end',
    cell: (r) => r.total,
  },
];
const rows: Row[] = [{ id: '1', name: 'Order one', status: 'Paid', total: '$5.00' }];

describe('ActivityTable', () => {
  it('renders the rows with column names on the labelled cells and fixed widths', () => {
    const html = renderToStaticMarkup(
      <ActivityTable caption="Recent" columns={columns} rows={rows} rowKey={(r) => r.id} />,
    );
    expect(html).toContain('<caption class="sr-only">Recent</caption>');
    expect(html).toContain('data-label="Total"');
    expect(html).not.toContain('data-label="Name"');
    expect(html).toContain('lg:table-fixed');
    expect(html).toContain('<col class="w-44"/>');
    expect(html).toContain('<col class="w-40"/>');
    expect(html).toContain('Order one');
  });

  it('ends the header of a figure column where its cells end', () => {
    const html = renderToStaticMarkup(
      <ActivityTable caption="Recent" columns={columns} rows={rows} rowKey={(r) => r.id} />,
    );
    expect(html).toMatch(/<th scope="col" class="[^"]*text-end[^"]*">Total<\/th>/);
  });
});

describe('formatCount', () => {
  it('adds a plus only when more exist and groups by the locale', () => {
    expect(formatCount(25, true, 'en-AU')).toBe('25+');
    expect(formatCount(7, false, 'en-AU')).toBe('7');
    expect(formatCount(1200, false, 'en-AU')).toBe('1,200');
    expect(formatCount(1200, false, 'de-DE')).toBe('1.200');
  });
});
