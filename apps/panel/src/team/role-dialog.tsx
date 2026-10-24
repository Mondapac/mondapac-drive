'use client';

import { Banner, Button, Dialog, Select, TextField } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { useNotice } from './notice.tsx';
import { roleLabel } from './role-label.ts';
import { roleOptions } from './role-options.ts';
import type { PlatformRole } from './types.ts';

/** Answers that mean the list is out of date: the dialog closes and the list is reloaded. */
const CHANGED_MEANWHILE: ReadonlySet<string> = new Set([
  'conflict.stale',
  'account.unknown',
  'role.unknown',
]);

function useMessageFor() {
  const t = useTranslations('identity.members');
  const te = useTranslations('identity');
  return (code: string): string => {
    if (t.has(`reason.${code}`)) return t(`reason.${code}`);
    if (te.has(`error.${code}`)) return te(`error.${code}`);
    return te('error.unknown');
  };
}

/** One submit at a time, even when the button is pressed twice before a render. */
function useSingleFlight() {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  return {
    pending,
    async run<T>(task: () => Promise<T>): Promise<T | undefined> {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      setPending(true);
      try {
        return await task();
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
  };
}

/** D2: change an admin's role. The change applies from their next request; they stay signed in. */
export function ChangeRoleDialog({
  open,
  onClose,
  accountId,
  name,
  currentRoleId,
  roles,
  csrfToken,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly accountId: string;
  readonly name: string;
  readonly currentRoleId: string | null;
  readonly roles: readonly PlatformRole[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('identity.members');
  const root = useTranslations();
  const router = useRouter();
  const notify = useNotice();
  const messageFor = useMessageFor();
  const flight = useSingleFlight();
  const [roleId, setRoleId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const options = useMemo(() => roleOptions(root, roles), [root, roles]);
  const current = roles.find((role) => role.roleId === currentRoleId) ?? null;

  // A closed dialog starts clean next time: no old choice, error or stale role id.
  useEffect(() => {
    if (!open) {
      setRoleId('');
      setProblem(null);
      setRoleError(null);
    }
  }, [open]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    setRoleError(null);
    if (roleId === '') {
      setRoleError(t('dialog.change-role.choose'));
      return;
    }
    await flight.run(async () => {
      setProblem(null);
      const result = await callApi(
        'POST',
        `identity/admin/accounts/${accountId}/role`,
        { roleId },
        csrfToken,
      );
      if (result.ok) {
        onClose();
        notify({ tone: 'success', text: t('toast.change-role', { name }) });
        router.refresh();
        return;
      }
      const failure: ApiFailure = result.failure;
      if (failure.status === 401) {
        router.replace('/session-ended');
        return;
      }
      if (CHANGED_MEANWHILE.has(failure.code)) {
        onClose();
        notify({ tone: 'critical', text: messageFor(failure.code) });
        router.refresh();
        return;
      }
      setProblem(messageFor(failure.code));
    });
  }

  return (
    <Dialog
      open={open}
      title={t('dialog.change-role.title', { name })}
      onClose={() => {
        if (!flight.pending) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={flight.pending}>
            {t('dialog.keep')}
          </Button>
          <Button loading={flight.pending} onClick={() => void submit()}>
            {t('dialog.change-role.action')}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
        <p>{t('dialog.change-role.body')}</p>
        <p className="text-sm text-fg-muted">
          {t('dialog.change-role.current', { role: roleLabel(root, current) })}
        </p>
        <Select
          label={t('dialog.change-role.label')}
          value={roleId}
          onChange={(event) => setRoleId(event.target.value)}
          placeholder={t('dialog.change-role.placeholder')}
          options={options.filter((option) => option.value !== currentRoleId)}
          error={roleError ?? undefined}
        />
        {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
      </form>
    </Dialog>
  );
}

/** D1: invite an admin. The same toast for any address (DD 6.7). */
export function InviteAdminDialog({
  open,
  onClose,
  roles,
  csrfToken,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly roles: readonly PlatformRole[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('identity.members');
  const root = useTranslations();
  const router = useRouter();
  const notify = useNotice();
  const messageFor = useMessageFor();
  const flight = useSingleFlight();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const options = useMemo(() => roleOptions(root, roles), [root, roles]);

  useEffect(() => {
    if (!open) {
      setEmail('');
      setRoleId('');
      setEmailError(null);
      setRoleError(null);
      setProblem(null);
    }
  }, [open]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const address = email.trim();
    setEmailError(null);
    setRoleError(null);
    setProblem(null);
    if (address === '') {
      setEmailError(root('identity.error.validation.email.required'));
      return;
    }
    if (roleId === '') {
      setRoleError(t('dialog.invite.choose'));
      return;
    }
    await flight.run(async () => {
      const result = await callApi(
        'POST',
        'identity/admin/invitations',
        { email: address, roleId },
        csrfToken,
      );
      if (result.ok) {
        onClose();
        notify({ tone: 'success', text: t('dialog.invite.toast-sent', { email: address }) });
        router.refresh();
        return;
      }
      const failure: ApiFailure = result.failure;
      if (failure.status === 401) {
        router.replace('/session-ended');
        return;
      }
      if (failure.code === 'validation.failed') {
        const fields = failure.details?.fields ?? [];
        if (fields.some((field) => field.path === 'email'))
          setEmailError(root('identity.error.validation.email.format'));
        else if (fields.some((field) => field.path === 'roleId'))
          setRoleError(t('dialog.invite.choose'));
        else setProblem(messageFor('unknown'));
        return;
      }
      if (
        failure.code === 'role.unknown' ||
        failure.code === 'role.not-grantable' ||
        failure.code === 'conflict.stale'
      )
        router.refresh();
      setProblem(messageFor(failure.code));
    });
  }

  return (
    <Dialog
      open={open}
      title={t('dialog.invite.title')}
      onClose={() => {
        if (!flight.pending) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={flight.pending}>
            {t('dialog.invite.cancel')}
          </Button>
          <Button loading={flight.pending} onClick={() => void submit()}>
            {t('dialog.invite.action')}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
        <TextField
          label={root('identity.common.label.email')}
          type="email"
          name="email"
          autoComplete="off"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={emailError ?? undefined}
        />
        <Select
          label={t('dialog.invite.label-role')}
          value={roleId}
          onChange={(event) => setRoleId(event.target.value)}
          placeholder={t('dialog.change-role.placeholder')}
          options={options}
          error={roleError ?? undefined}
        />
        <p className="text-sm text-fg-muted">
          {t('dialog.invite.help', { duration: t('dialog.invite.duration') })}
        </p>
        {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
      </form>
    </Dialog>
  );
}
