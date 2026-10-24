'use client';

import { Banner, Button, OtpField, TextField } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { FocusHeading } from './focus-heading.tsx';
import { fieldErrorKeys, formErrorKey, type ErrorKey } from './messages-for-errors.ts';
import { ProblemBanner } from './problem-banner.tsx';
import { useFocusFirstInvalid } from './use-focus-first-invalid.ts';
import { useThrottle } from './use-throttle.ts';

export type SignInNotice = 'session-ended' | 'signed-out' | 'password-changed' | 'account-ready';

type PasswordStep = { code: string; challengeToken?: string };

/**
 * Admin sign-in (identity ux F2, F7): the password step, then the code step (A7), or the notice
 * that a link to set up two-step verification again was mailed (A3, F6 step 6). The challenge
 * token lives in this component's memory only: never in the URL or in browser storage.
 */
export function SignInFlow({ notice }: { readonly notice: SignInNotice | null }) {
  const [challenge, setChallenge] = useState<string | null>(null);
  const [ended, setEnded] = useState<ApiFailure | null>(null);
  const [reEnrol, setReEnrol] = useState<string | null>(null);
  const t = useTranslations('identity');
  useDocumentTitle(reEnrol !== null ? 'check-email' : challenge !== null ? 'two-step' : null);
  if (reEnrol !== null) {
    return (
      <div className="flex flex-col gap-4">
        <FocusHeading>{t('check-email.title')}</FocusHeading>
        <p className="text-fg-secondary">{t('check-email.body.re-enrol', { email: reEnrol })}</p>
        <button
          type="button"
          className="self-start text-sm text-link hover:underline"
          onClick={() => setReEnrol(null)}
        >
          {t('common.action.back-to-sign-in')}
        </button>
      </div>
    );
  }
  if (challenge !== null) {
    return (
      <CodeStep
        challengeToken={challenge}
        onEnded={(failure) => {
          setEnded(failure);
          setChallenge(null);
        }}
      />
    );
  }
  return (
    <PasswordForm
      notice={notice}
      endedBy={ended}
      onCode={(token) => {
        setEnded(null);
        setChallenge(token);
      }}
      onReEnrol={(email) => setReEnrol(email)}
    />
  );
}

function PasswordForm({
  notice,
  endedBy,
  onCode,
  onReEnrol,
}: {
  readonly notice: SignInNotice | null;
  /** Why the code step ended, when it did: the message and any wait show here (ux F7 step 1). */
  readonly endedBy: ApiFailure | null;
  readonly onCode: (token: string) => void;
  readonly onReEnrol: (email: string) => void;
}) {
  const t = useTranslations('identity');
  const formRef = useRef<HTMLFormElement>(null);
  const throttle = useThrottle();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<ErrorKey>(() =>
    endedBy === null ? null : formErrorKey(endedBy),
  );
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const focusKeys = useMemo(
    () => ({ ...fieldErrors, ...(formError ? { '#form': formError.key } : {}) }),
    [fieldErrors, formError],
  );
  useFocusFirstInvalid(formRef, focusKeys);
  useEffect(() => {
    if (endedBy?.code === 'second-factor.locked') {
      throttle.start(endedBy.details?.retryAfterSeconds ?? 60);
    }
    // Runs once, when the form appears after the code step.
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    const result = await callApi<PasswordStep>('POST', 'identity/admin/sign-in', {
      email: email.trim(),
      password,
    });
    setPending(false);
    if (result.ok) {
      setPassword('');
      if (result.body.code === 'second-factor-required' && result.body.challengeToken) {
        onCode(result.body.challengeToken);
      } else if (result.body.code === 'second-factor-enrolment-required') {
        onReEnrol(email.trim());
      } else {
        setFormError({ key: 'unknown' });
      }
      return;
    }
    const { failure } = result;
    if (failure.code === 'validation.failed') {
      setFieldErrors(fieldErrorKeys(failure, ['email', 'password']));
      return;
    }
    setPassword('');
    if (failure.code === 'request.throttled' || failure.code === 'second-factor.locked') {
      throttle.start(failure.details?.retryAfterSeconds ?? 60);
    }
    setFormError(formErrorKey(failure));
  }

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-5"
    >
      {notice ? <Banner tone="info">{t(`sign-in.banner.${notice}`)}</Banner> : null}
      {formError ? <ProblemBanner message={t(`error.${formError.key}`, formError.values)} /> : null}
      <TextField
        label={t('common.label.email')}
        type="email"
        name="email"
        autoComplete="username"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={fieldErrors['email'] ? t(`error.${fieldErrors['email']}`) : undefined}
      />
      <TextField
        label={t('common.label.password')}
        type="password"
        name="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        showLabel={t('common.action.show-password')}
        hideLabel={t('common.action.hide-password')}
        error={fieldErrors['password'] ? t(`error.${fieldErrors['password']}`) : undefined}
      />
      <Button type="submit" block loading={pending} disabled={throttle.blocked}>
        {t('sign-in.action.submit')}
      </Button>
      <Link href="/forgot-password" className="text-sm text-link hover:underline">
        {t('sign-in.action.forgot')}
      </Link>
    </form>
  );
}

function CodeStep({
  challengeToken,
  onEnded,
}: {
  readonly challengeToken: string;
  readonly onEnded: (failure: ApiFailure) => void;
}) {
  const t = useTranslations('identity');
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  // A new key clears the six boxes and puts focus back in the first one.
  const [boxes, setBoxes] = useState(0);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<ErrorKey>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const throttle = useThrottle();
  // A wrong code in the six boxes keeps focus in the first box (the banner is still announced).
  const focusKeys = useMemo(
    () => ({ ...fieldErrors, ...(formError && backup ? { '#form': formError.key } : {}) }),
    [fieldErrors, formError, backup],
  );
  useFocusFirstInvalid(formRef, focusKeys);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await verify(code);
  }

  async function verify(entered: string) {
    if (pending || throttle.blocked) return;
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    const result = await callApi<{ code: 'signed-in' }>('POST', 'identity/admin/second-factor', {
      challengeToken,
      // A code pasted from the app may carry spaces; a backup code may carry spaces or hyphens.
      code: entered.replace(/[\s-]/g, ''),
    });
    if (result.ok) {
      router.replace('/');
      router.refresh();
      return;
    }
    setPending(false);
    const { failure } = result;
    if (failure.code === 'validation.failed') {
      setFieldErrors(fieldErrorKeys(failure, ['code']));
      return;
    }
    setCode('');
    setBoxes((count) => count + 1);
    if (failure.code === 'challenge.rejected' || failure.code === 'second-factor.locked') {
      // The challenge is over: back to the password step, which says why (ux F7 step 1).
      onEnded(failure);
      return;
    }
    if (failure.code === 'request.throttled') {
      throttle.start(failure.details?.retryAfterSeconds ?? 60);
    }
    setFormError(formErrorKey(failure));
  }

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-5"
    >
      <FocusHeading key={backup ? 'backup' : 'app'}>
        {t(backup ? 'two-step.title-backup' : 'two-step.title')}
      </FocusHeading>
      <p className="text-fg-secondary">{t(backup ? 'two-step.body-backup' : 'two-step.body')}</p>
      {formError ? <ProblemBanner message={t(`error.${formError.key}`, formError.values)} /> : null}
      {backup ? (
        <TextField
          label={t('two-step.label.backup-code')}
          name="code"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          error={fieldErrors['code'] ? t(`error.${fieldErrors['code']}`) : undefined}
          dir="ltr"
        />
      ) : (
        <OtpField
          key={boxes}
          label={t('two-step.label.code')}
          digitLabel={(position, total) => t('two-step.label.digit', { position, total })}
          name="code"
          // On arrival the heading keeps focus (it announces the step); after a wrong code the first box does.
          autoFocus={boxes > 0}
          readOnly={pending}
          error={fieldErrors['code'] ? t(`error.${fieldErrors['code']}`) : undefined}
          onChange={setCode}
          onComplete={(complete) => void verify(complete)}
        />
      )}
      <Button type="submit" block loading={pending} disabled={throttle.blocked}>
        {t('two-step.action.verify')}
      </Button>
      <button
        type="button"
        className="self-start text-sm text-link hover:underline"
        onClick={() => {
          setBackup(!backup);
          setCode('');
          setFormError(null);
          setFieldErrors({});
        }}
      >
        {t(backup ? 'two-step.action.use-app' : 'two-step.action.use-backup')}
      </button>
      <p className="text-sm text-fg-muted">{t('two-step.help.admin')}</p>
    </form>
  );
}

/** The document title follows the step (identity ux 6): the sign-in title when `surface` is null. */
function useDocumentTitle(surface: 'two-step' | 'check-email' | null) {
  const t = useTranslations('identity');
  useEffect(() => {
    if (surface === null) return undefined;
    const previous = document.title;
    document.title = t(`${surface}.page-title`);
    return () => {
      document.title = previous;
    };
  }, [surface, t]);
}
