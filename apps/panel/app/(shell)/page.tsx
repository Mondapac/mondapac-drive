import {
  LoadError,
  ShortcutGrid,
  StatCard,
  StatGrid,
  formatCount,
  type Shortcut,
  visibleNavItems,
} from '@mondapac-drive/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { adminNav } from '../../src/nav.ts';
import { cardHref, countReadsFor } from '../../src/ops/home-counts.ts';
import { AdminShell } from '../../src/server/admin-shell.tsx';
import { serverGet } from '../../src/server/server-fetch.ts';
import { requireSession } from '../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('home.title') };
}

/**
 * Home: what needs the operator now (a figure per list the session may read, each linking to
 * that list), then one card per section the session's role includes (the nav, without Home).
 */
export default async function HomePage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const locale = await getLocale();
  const keys = new Set(gate.session.permissionKeys);
  const nav = visibleNavItems(adminNav, keys);
  const navHrefs = new Set(nav.map((item) => item.href));
  const reads = countReadsFor(keys);
  const results = await Promise.all(reads.map((read) => serverGet<unknown>(read.path)));
  if (results.some((result) => result.kind === 'signed-out')) redirect('/session-ended');
  const figures = reads.map((read, index) => {
    const result = results[index];
    return { read, figure: result?.kind === 'ok' ? read.count(result.body) : null };
  });
  const allClear =
    figures.length > 0 && figures.every(({ figure }) => figure !== null && figure.count === 0);
  const items: Shortcut[] = nav
    .filter((item) => item.id !== 'home')
    .map((item) => ({
      id: item.id,
      href: item.href,
      icon: item.icon,
      title: t(item.labelKey),
      body: t(`home.${item.id}`),
    }));
  return (
    <AdminShell session={gate.session} activeId="home" title={t('home.title')}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="break-words text-2xl font-semibold">{t('home.title')}</h1>
          <p className="text-fg-muted">{t('home.intro', { name: gate.session.displayName })}</p>
        </div>
        {figures.length === 0 ? null : (
          <section aria-labelledby="home-now" className="flex flex-col gap-3">
            <h2 id="home-now" className="text-lg font-semibold">
              {t('home-now.title')}
            </h2>
            {allClear ? <p className="text-fg-muted">{t('home-now.all-clear')}</p> : null}
            <StatGrid label={t('home-now.title')}>
              {figures.map(({ read, figure }) => {
                const href = cardHref(read, navHrefs);
                return (
                  <StatCard
                    key={read.id}
                    icon={read.icon}
                    label={t(`home-now.${read.id}.label`)}
                    value={figure === null ? '' : formatCount(figure.count, figure.hasMore, locale)}
                    scope={t(`home-now.${read.id}.scope`)}
                    tone={figure !== null && figure.count > 0 ? read.tone : 'neutral'}
                    {...(href === null ? {} : { href })}
                    {...(figure === null ? { error: t('home-now.error') } : {})}
                  />
                );
              })}
            </StatGrid>
          </section>
        )}
        <ShortcutGrid label={t('home.shortcuts')} items={items} />
      </div>
    </AdminShell>
  );
}
