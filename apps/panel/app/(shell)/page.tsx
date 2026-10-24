import { LoadError, ShortcutGrid, type Shortcut, visibleNavItems } from '@mondapac-drive/ui';
import { getTranslations } from 'next-intl/server';
import { adminNav } from '../../src/nav.ts';
import { AdminShell } from '../../src/server/admin-shell.tsx';
import { requireSession } from '../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('home.title') };
}

/** Home: one card per section the session's role includes (the nav, without Home itself). */
export default async function HomePage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const items: Shortcut[] = visibleNavItems(adminNav, new Set(gate.session.permissionKeys))
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
        <ShortcutGrid label={t('home.shortcuts')} items={items} />
      </div>
    </AdminShell>
  );
}
