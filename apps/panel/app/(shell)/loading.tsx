import { RouteLoading, SIDEBAR_COOKIE, sidebarCollapsed } from '@mondapac-drive/ui';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

/** Shown while a page renders on the server; the frame matches the shell, so nothing jumps. */
export default async function Loading() {
  const t = await getTranslations('route');
  const collapsed = sidebarCollapsed((await cookies()).get(SIDEBAR_COOKIE)?.value);
  return <RouteLoading label={t('loading')} collapsed={collapsed} />;
}
