'use client';

import { Banner, Button, Card, OtpField, TextField } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { passwordProblemOf, type Problem } from './errors.ts';

/**
 * Change the signed-in user's own password. An admin always confirms with a code from the app (or
 * a backup code); the API ends every other session and keeps this one, with a new token, so the
 * page is refreshed to pick up the new CSRF token.
 */
export function PasswordCard({
  csrfToken,
  passwordMin,
  passwordMax,
}: {
  readonly csrfToken: string;
  readonly passwordMin: number;
  readonly passwordMax: number;
}) {
  const t = useTranslations('profile');
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);
  const [boxes, setBoxes] = useState(0);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saved, setSaved] = useState(false);
  const busy = useRef(false);

  function focusInvalid() {
    queueMicrotask(() =>
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    );
  }
  function refuse(refused: Problem) {
    setProblem(refused);
    if (refused.field === 'code') {
      setCode('');
      setBoxes((n) => n + 1);
    }
    focusInvalid();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    setSaved(false);
    setProblem(null);
    const limits = { min: passwordMin, max: passwordMax };
    if (current === '') return refuse({ key: 'current-required', field: 'current' });
    const length = [...next].length;
    if (length < passwordMin || length > passwordMax) {
      return refuse({ key: 'new-length', field: 'new', values: limits });
    }
    if (code.trim() === '') return refuse({ key: 'code-required', field: 'code' });
    busy.current = true;
    setPending(true);
    const result = await callApi(
      'POST',
      'identity/admin/change-password',
      { currentPassword: current, newPassword: next, code: code.trim() },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setCurrent('');
      setNext('');
      setCode('');
      setBoxes((n) => n + 1);
      setSaved(true);
      router.refresh();
      return;
    }
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else refuse(passwordProblemOf(result.failure, limits));
  }

  const errorOf = (field: NonNullable<Problem['field']>) =>
    problem?.field === field ? t(`error.${problem.key}`, problem.values) : undefined;
  return (
    <Card title={t('password-title')}>
      <form
        ref={formRef}
        className="flex flex-col gap-4 sm:max-w-md"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <p className="text-sm text-fg-muted">{t('password-intro')}</p>
        {saved ? <Banner tone="success">{t('password-saved')}</Banner> : null}
        {problem === null || problem.field !== null ? null : (
          <Banner tone="critical">{t(`error.${problem.key}`, problem.values)}</Banner>
        )}
        <TextField
          name="current-password"
          type="password"
          label={t('current-password')}
          autoComplete="current-password"
          value={current}
          showLabel={t('show-password')}
          hideLabel={t('hide-password')}
          error={errorOf('current')}
          onChange={(event) => setCurrent(event.target.value)}
        />
        <TextField
          name="new-password"
          type="password"
          label={t('new-password')}
          autoComplete="new-password"
          value={next}
          showLabel={t('show-password')}
          hideLabel={t('hide-password')}
          help={t('new-password-help', { min: passwordMin, max: passwordMax })}
          error={errorOf('new')}
          onChange={(event) => setNext(event.target.value)}
        />
        {backup ? (
          <TextField
            key={`backup-${boxes}`}
            name="code"
            label={t('backup-label')}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={code}
            error={errorOf('code')}
            onChange={(event) => setCode(event.target.value)}
          />
        ) : (
          <OtpField
            key={`app-${boxes}`}
            label={t('code-label')}
            digitLabel={(position, total) => t('code-digit', { position, total })}
            name="code"
            readOnly={pending}
            error={errorOf('code')}
            onChange={setCode}
          />
        )}
        <div>
          <button
            type="button"
            disabled={pending}
            className="min-h-11 text-sm font-medium text-link underline disabled:opacity-60"
            onClick={() => {
              setBackup((value) => !value);
              setCode('');
              setProblem(null);
            }}
          >
            {t(backup ? 'use-app' : 'use-backup')}
          </button>
        </div>
        <div>
          <Button type="submit" loading={pending}>
            {t('password-save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
