'use client';

import { useTranslations } from 'next-intl';
import { FormButton } from '../ops/form-button.tsx';

/** "Add merchant" (identity.merchant.create): the business name only. */
export function AddMerchantButton({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations('merchants.add');
  const ops = useTranslations('ops');
  return (
    <FormButton
      copy={{
        button: t('button'),
        title: t('title'),
        label: t('name'),
        help: t('help'),
        action: t('action'),
        cancel: ops('cancel'),
        done: (name) => t('done', { name }),
      }}
      path="identity/admin/merchants"
      field="name"
      maxLength={100}
      csrfToken={csrfToken}
    />
  );
}
