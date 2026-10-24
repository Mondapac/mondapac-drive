'use client';

import { Banner, Button, TextField } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { FocusHeading } from './focus-heading.tsx';
import { useFocusFirstInvalid } from './use-focus-first-invalid.ts';
import { callApi } from '../api/client.ts';
import { useLinkToken } from './link-token.ts';
import { formErrorKey, passwordRuleKey } from './messages-for-errors.ts';

export function ResetPasswordForm({
  passwordMin,
  passwordMax,
}: {
  readonly passwordMin: number;
  readonly passwordMax: number;
}) {
  const t = useTranslations('identity');
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const link = useLinkToken();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [error, setError] = useState<{
    key: string;
    values?: Record<string, string | number>;
  } | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const invalid = useMemo<Record<string, string>>(() => {
    const errors: Record<string, string> = {};
    if (passwordError) errors['password'] = passwordError;
    return errors;
  }, [passwordError]);
  useFocusFirstInvalid(formRef, invalid);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (link.state !== 'present') return;
    setPending(true);
    setError(null);
    setPasswordError(null);
    const result = await callApi('POST', 'identity/admin/reset-password', {
      token: link.token,
      password,
    });
    if (result.ok) {
      router.replace('/sign-in?notice=password-changed');
      return;
    }
    setPending(false);
    const { failure } = result;
    if (failure.code === 'link.rejected') {
      setRejected(true);
      return;
    }
    if (failure.code === 'password.rejected') {
      setPasswordError(passwordRuleKey(failure));
      return;
    }
    if (failure.code === 'validation.failed') {
      setPasswordError('validation.password.required');
      return;
    }
    setError(formErrorKey(failure));
  }

  if (link.state === 'checking') {
    return (
      <p role="status" className="text-fg-muted">
        {t('reset-password.status.checking')}
      </p>
    );
  }
  if (link.state === 'missing' || rejected) {
    return (
      <div className="flex flex-col gap-5">
        <FocusHeading>{t('link.title.rejected')}</FocusHeading>
        <p className="text-fg-secondary">{t('link.body.rejected')}</p>
        <Link href="/forgot-password" className="text-sm text-link hover:underline">
          {t('forgot-password.action.submit')}
        </Link>
      </div>
    );
  }
  return (
    <form
      ref={formRef}
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-5"
    >
      <p className="text-fg-secondary">{t('reset-password.body')}</p>
      {error ? <Banner tone="critical">{t(`error.${error.key}`, error.values)}</Banner> : null}
      <TextField
        label={t('common.label.new-password')}
        type="password"
        name="new-password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        showLabel={t('common.action.show-password')}
        hideLabel={t('common.action.hide-password')}
        help={t('common.help.password', { min: passwordMin, max: passwordMax })}
        error={
          passwordError
            ? t(`error.${passwordError}`, { min: passwordMin, max: passwordMax })
            : undefined
        }
      />
      <Button type="submit" block loading={pending}>
        {t('reset-password.action.submit')}
      </Button>
    </form>
  );
}
