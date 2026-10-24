import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Card } from '../form/card.tsx';
import { LoadError } from '../form/load-error.tsx';
import { CARD_TABLE } from './card-table.ts';
import { DataList } from './data-list.tsx';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('DataList', () => {
  const rows = [
    { label: 'Items', value: '$43.50' },
    { label: 'Total', value: '$48.50', emphasis: true },
    { label: 'Note', value: null },
  ];

  it('totals: end-aligns amounts and sets the emphasised row apart', () => {
    const out = html(<DataList rows={rows} missing="Not given" variant="totals" />);
    expect(out).toContain('tabular-nums');
    expect(out).toMatch(/border-t[^"]*font-semibold[^"]*"><dt>Total<\/dt>/);
    expect(out.match(/<dt/g)).toHaveLength(3);
  });

  it('stacked: label above value, and the missing text for a null value', () => {
    const out = html(<DataList rows={rows} missing="Not given" variant="stacked" />);
    expect(out).toContain('grid gap-y-3');
    expect(out).not.toContain('--mp-size-data-label');
    expect(out).toContain('Not given');
  });

  it('default keeps the shared label column', () => {
    const out = html(<DataList rows={rows} missing="-" />);
    expect(out).toContain('--mp-size-data-label');
  });
});

describe('Card', () => {
  it('flush: no body padding, a rule under the heading, clipped corners', () => {
    const out = html(
      <Card title="Items" flush>
        <p>Body</p>
      </Card>,
    );
    expect(out).toContain('overflow-hidden');
    expect(out).toContain('border-t');
    expect(out).not.toContain('p-5"');
  });

  it('default keeps its padded body', () => {
    const out = html(
      <Card title="Items">
        <p>Body</p>
      </Card>,
    );
    expect(out).toContain('p-5');
    expect(out).not.toContain('overflow-hidden');
  });
});

describe('LoadError', () => {
  it('renders the page h1 only when a title is given', () => {
    expect(html(<LoadError message="m" retryLabel="r" />)).not.toContain('<h1');
    expect(html(<LoadError message="m" retryLabel="r" title="Orders" />)).toContain('<h1');
  });
});

describe('CARD_TABLE labelled cell', () => {
  it('puts label and value on one row on phones', () => {
    expect(CARD_TABLE.labelled).toContain('max-lg:grid-cols-[minmax(0,7rem)_minmax(0,1fr)]');
    expect(CARD_TABLE.labelled).toContain('max-lg:justify-items-start');
    expect(CARD_TABLE.labelled).toContain('max-lg:[&>*]:col-start-2');
  });
});
