'use client';

import { Button } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { InviteAdminDialog } from './role-dialog.tsx';
import type { PlatformRole } from './types.ts';

/** The primary action of B1 (ux 3.2): "Invite admin". Shown only to an actor who may invite. */
export function InviteAdminButton({
  roles,
  csrfToken,
}: {
  readonly roles: readonly PlatformRole[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('identity.members');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('action.invite-admin')}</Button>
      <InviteAdminDialog
        open={open}
        onClose={() => setOpen(false)}
        roles={roles}
        csrfToken={csrfToken}
      />
    </>
  );
}
