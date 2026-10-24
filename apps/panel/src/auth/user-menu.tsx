'use client';

import { AccountMenu, type AccountMenuLink, type ThemeChoice } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { callApi } from '../api/client.ts';

/** The topbar's account menu: who is signed in, their own pages, the theme and sign-out. */
export function UserMenu({
  name,
  email,
  theme,
  csrfToken,
}: {
  readonly name: string;
  readonly email: string;
  readonly theme: ThemeChoice;
  readonly csrfToken: string;
}) {
  const t = useTranslations('account-menu');
  const themeT = useTranslations('theme');
  const router = useRouter();
  const links: readonly AccountMenuLink[] = [
    { id: 'profile', label: t('profile'), href: '/account/profile', icon: 'user' },
    { id: 'sessions', label: t('sessions'), href: '/account/sessions', icon: 'monitor' },
  ];

  async function signOut(): Promise<boolean> {
    const result = await callApi('POST', 'identity/admin/sign-out', {}, csrfToken);
    // Signed out, or the session was already gone: both end on the sign-in page. Anything else
    // means the session may still be live, so the menu says so and stays.
    if (result.ok || result.failure.status === 401) {
      router.replace('/sign-in?notice=signed-out');
      router.refresh();
      return true;
    }
    return false;
  }

  return (
    <AccountMenu
      name={name}
      email={email}
      links={links}
      theme={theme}
      labels={{
        trigger: t('trigger', { name }),
        pages: t('pages'),
        theme: themeT('menu'),
        system: themeT('system'),
        light: themeT('light'),
        dark: themeT('dark'),
        signOut: t('sign-out'),
        signingOut: t('signing-out'),
      }}
      onSignOut={signOut}
      signOutError={t('sign-out-failed')}
    />
  );
}
