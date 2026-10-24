'use client';

import { RouteError } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';

/** A page that failed to render. The error itself stays in the server log; the digest finds it. */
export default function RouteErrorPage({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  const t = useTranslations('route.error');
  return (
    <RouteError
      title={t('title')}
      message={t('message')}
      retryLabel={t('retry')}
      onRetry={reset}
      homeLabel={t('home')}
      homeHref="/"
      reference={error.digest}
      referenceLabel={t('reference')}
    />
  );
}
