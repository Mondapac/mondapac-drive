import { getTranslations } from 'next-intl/server';

/** The body of a screen the session's role does not include; the API would refuse it anyway. */
export async function NoAccess({ scope }: { readonly scope: string }) {
  const t = await getTranslations();
  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold">{t(`${scope}.no-access.title`)}</h1>
      <p className="text-fg-muted">{t(`${scope}.no-access.body`)}</p>
      <p className="mt-4">
        <a className="inline-flex min-h-12 items-center font-medium text-link underline" href="/">
          {t('identity.members.no-access.action')}
        </a>
      </p>
    </>
  );
}
