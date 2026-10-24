import { AuthLayout } from '@mondapac-drive/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { panelConfig } from '../server/config.ts';
import { supportEmail } from '../server/support-email.ts';

/** The admin Auth template with the Market's name and support address (identity ux 3.1). */
export async function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  const t = await getTranslations();
  const config = panelConfig();
  const email = await supportEmail();
  return (
    <AuthLayout
      panel="admin"
      badge={t('identity.common.account-type.admin')}
      title={title}
      marketName={t('panel.market', { marketName: config.marketName })}
      supportLine={t('panel.support', { supportEmail: email })}
      showcaseTitle={t('showcase.title')}
      showcaseCards={(['one', 'two', 'three'] as const).map((key) => ({
        name: t(`showcase.cards.${key}.name`),
        detail: t(`showcase.cards.${key}.detail`),
      }))}
    >
      {children}
    </AuthLayout>
  );
}
