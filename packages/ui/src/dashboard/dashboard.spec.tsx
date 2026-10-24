import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DashboardCard, DistributionBar, StatCard, StatGrid } from './dashboard.tsx';

describe('StatCard', () => {
  it('links to the list it counts and always shows its scope', () => {
    const html = renderToStaticMarkup(
      <StatGrid label="Needs attention">
        <StatCard
          icon="store"
          label="Awaiting review"
          value="12"
          scope="all sellers"
          href="/sellers"
        />
      </StatGrid>,
    );
    expect(html).toContain('<a href="/sellers"');
    expect(html).toContain('12');
    expect(html).toContain('all sellers');
    expect(html).toContain('aria-label="Needs attention"');
  });

  it('says what failed in place and does not link', () => {
    const html = renderToStaticMarkup(
      <StatCard
        icon="store"
        label="Awaiting review"
        value="12"
        scope="all"
        href="/x"
        error="Could not load"
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not load');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('>12<');
  });
});

describe('DashboardCard', () => {
  it('names the region by its heading and links to the full page', () => {
    const html = renderToStaticMarkup(
      <DashboardCard id="c" title="Recent orders" action={{ href: '/orders', label: 'View all' }}>
        <p>body</p>
      </DashboardCard>,
    );
    expect(html).toContain('aria-labelledby="c"');
    expect(html).toContain('<h2 id="c"');
    expect(html).toContain('href="/orders"');
  });

  it('replaces the body and the link with the error', () => {
    const html = renderToStaticMarkup(
      <DashboardCard id="c" title="T" action={{ href: '/o', label: 'All' }} error="Failed">
        <p>body</p>
      </DashboardCard>,
    );
    expect(html).toContain('Failed');
    expect(html).not.toContain('body');
    expect(html).not.toContain('href="/o"');
  });
});

describe('DistributionBar', () => {
  const parts = [
    { id: 'a', label: 'Approved', value: 3, tone: 'success' as const },
    { id: 'b', label: 'Suspended', value: 1, tone: 'critical' as const },
    { id: 'c', label: 'Other', value: 0, tone: 'neutral' as const },
  ];

  it('draws the non-zero parts and lists every part as text', () => {
    const html = renderToStaticMarkup(<DistributionBar parts={parts} emptyLabel="None" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/<rect/g)).toHaveLength(2);
    expect(html).toContain('width="75"');
    for (const word of ['Approved', 'Suspended', 'Other']) expect(html).toContain(word);
  });

  it('says so instead of drawing an empty bar', () => {
    const html = renderToStaticMarkup(
      <DistributionBar parts={parts.map((p) => ({ ...p, value: 0 }))} emptyLabel="None yet" />,
    );
    expect(html).toContain('None yet');
    expect(html).not.toContain('<svg');
  });
});
