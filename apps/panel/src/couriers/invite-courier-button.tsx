'use client';

import { useTranslations } from 'next-intl';
import { FormButton } from '../ops/form-button.tsx';

/** "Invite courier" (identity.courier-account.invite): the address only. */
export function InviteCourierButton({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations('couriers.invite');
  const ops = useTranslations('ops');
  return (
    <FormButton
      copy={{
        button: t('button'),
        title: t('title'),
        label: t('email'),
        help: t('help'),
        action: t('action'),
        cancel: ops('cancel'),
        done: (email) => t('done', { email }),
      }}
      path="identity/admin/couriers/invitations"
      field="email"
      type="email"
      maxLength={254}
      csrfToken={csrfToken}
    />
  );
}
