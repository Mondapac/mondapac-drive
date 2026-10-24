'use client';

import {
  BackLink,
  Banner,
  Button,
  CheckboxRow,
  Dialog,
  FormActionBar,
  TextField,
} from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { groupByResource, humanise } from './role-name.ts';
import type { RoleCatalogue, RoleRecord } from './types.ts';

const MAX_NAME = 80;
const MAX_KEYS = 40;
/** Drive: dispatching a courier also needs the courier view key (identity checks the courier). */
const DISPATCH_KEY = 'delivery.delivery.dispatch';
const COURIER_VIEW_KEY = 'identity.courier-account.view';
const CONTROL = /[\p{Cc}‎‏‪-‮⁦-⁩]/u;

/** Answers that mean the role changed or went away meanwhile: the page is reloaded. */
const RELOAD: ReadonlySet<string> = new Set(['conflict.stale', 'role.unknown', 'role.read-only']);

interface Written {
  readonly code: string;
  readonly roleId: string;
}

/** B3 / B4: create, edit, duplicate or delete a custom platform role. */
export function RoleEditor({
  role,
  catalogue,
  csrfToken,
  initialName,
  initialKeys,
}: {
  /** The custom role being edited; absent when creating (also when duplicating). */
  readonly role?: RoleRecord;
  readonly catalogue: RoleCatalogue;
  readonly csrfToken: string;
  readonly initialName: string;
  readonly initialKeys: readonly string[];
}) {
  const t = useTranslations('identity.roles');
  const root = useTranslations();
  const router = useRouter();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initialKeys));
  const [nameError, setNameError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const editing = role !== undefined;
  const keyInfo = new Map(catalogue.keys.map((entry) => [entry.key, entry]));
  const groups = groupByResource(catalogue.keys.map((entry) => entry.key));
  const canDelete = editing && role.actions.delete.allowed;

  function messageFor(code: string): string {
    if (t.has(`reason.${code}`)) return t(`reason.${code}`);
    if (root.has(`identity.members.reason.${code}`)) return root(`identity.members.reason.${code}`);
    if (root.has(`identity.error.${code}`)) return root(`identity.error.${code}`);
    return root('identity.error.unknown');
  }

  async function run(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await task();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function toggle(key: string, on: boolean) {
    setSaved(false);
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function fail(failure: ApiFailure) {
    if (failure.status === 401) {
      router.replace('/session-ended');
      return;
    }
    if (failure.code === 'validation.failed') {
      const fields = failure.details?.fields ?? [];
      if (fields.some((field) => field.path === 'name')) setNameError(t('editor.name-invalid'));
      else setProblem(messageFor('unknown'));
      return;
    }
    if (failure.code === 'role.name-taken') {
      setNameError(t('reason.role.name-taken'));
      return;
    }
    if (RELOAD.has(failure.code)) router.refresh();
    setProblem(messageFor(failure.code));
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    setNameError(null);
    setProblem(null);
    setSaved(false);
    const trimmed = name.trim();
    if (trimmed === '') {
      setNameError(t('editor.name-required'));
      return;
    }
    if (trimmed.length > MAX_NAME || CONTROL.test(trimmed)) {
      setNameError(t('editor.name-invalid'));
      return;
    }
    if (selected.size > MAX_KEYS) {
      setProblem(t('editor.too-many', { max: MAX_KEYS }));
      return;
    }
    await run(async () => {
      const body = { name: trimmed, permissionKeys: [...selected].sort() };
      const result = editing
        ? await callApi<Written>('PUT', `identity/admin/roles/${role.roleId}`, body, csrfToken)
        : await callApi<Written>('POST', 'identity/admin/roles', body, csrfToken);
      if (!result.ok) {
        fail(result.failure);
        return;
      }
      if (editing) {
        setSaved(true);
        router.refresh();
      } else {
        router.push(`/roles/${result.body.roleId}`);
      }
    });
  }

  async function remove() {
    if (!editing) return;
    await run(async () => {
      const result = await callApi<Written>(
        'DELETE',
        `identity/admin/roles/${role.roleId}`,
        undefined,
        csrfToken,
      );
      setConfirmDelete(false);
      if (!result.ok) {
        fail(result.failure);
        return;
      }
      router.push('/roles');
    });
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-5">
      <div className="flex flex-col items-start gap-2">
        <BackLink href="/roles" label={t('back')} />
        <h1 className="break-words text-2xl font-semibold">
          {editing ? t('editor.title-edit') : t('editor.title-create')}
        </h1>
      </div>
      {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
      <TextField
        label={t('editor.name')}
        help={t('editor.name-help', { max: MAX_NAME })}
        value={name}
        maxLength={MAX_NAME}
        error={nameError ?? undefined}
        onChange={(event) => {
          setSaved(false);
          setName(event.target.value);
        }}
      />
      <p className="text-fg-muted" aria-live="polite">
        {t('selected', { selected: selected.size, total: catalogue.keys.length })}
      </p>
      {/* Drive: assigning a courier checks the courier is active through identity, which needs
          the courier view key; without it every assignment is refused. */}
      {selected.has(DISPATCH_KEY) && !selected.has(COURIER_VIEW_KEY) ? (
        <Banner tone="attention">{t('editor.dispatch-needs-courier-view')}</Banner>
      ) : null}
      {groups.map(([resource, keys]) => (
        <fieldset key={resource} className="rounded-lg border border-line bg-surface p-5">
          <legend className="px-1 font-semibold">
            {root.has(`permission.resource.${resource}`)
              ? root(`permission.resource.${resource}`)
              : humanise(resource.split('.')[1] ?? resource)}
          </legend>
          <div className="flex flex-col gap-3">
            {keys.map((key) => {
              const info = keyInfo.get(key);
              const locked = info === undefined || !info.grantable;
              const label = root.has(`permission.${key}.label`)
                ? root(`permission.${key}.label`)
                : humanise(key.split('.').slice(2).join(' '));
              return (
                <CheckboxRow
                  key={key}
                  label={label}
                  {...(info?.protected === true
                    ? { help: t('editor.protected-help') }
                    : locked
                      ? { help: t('editor.not-grantable-help') }
                      : {})}
                  checked={selected.has(key)}
                  disabled={locked || pending}
                  onChange={(event) => toggle(key, event.target.checked)}
                />
              );
            })}
          </div>
        </fieldset>
      ))}
      <FormActionBar status={saved ? t('editor.saved') : undefined}>
        {canDelete ? (
          <Button
            variant="secondary"
            type="button"
            disabled={pending}
            onClick={() => setConfirmDelete(true)}
          >
            {t('editor.delete')}
          </Button>
        ) : null}
        <Button type="submit" loading={pending}>
          {editing ? t('editor.save') : t('editor.create')}
        </Button>
      </FormActionBar>
      <Dialog
        open={confirmDelete}
        title={t('editor.delete-title', { name: initialName })}
        onClose={() => {
          if (!pending) setConfirmDelete(false);
        }}
        actions={
          <>
            <Button variant="secondary" disabled={pending} onClick={() => setConfirmDelete(false)}>
              {t('editor.keep')}
            </Button>
            <Button variant="destructive" loading={pending} onClick={() => void remove()}>
              {t('editor.delete-confirm')}
            </Button>
          </>
        }
      >
        <p>{t('editor.delete-body')}</p>
      </Dialog>
    </form>
  );
}
