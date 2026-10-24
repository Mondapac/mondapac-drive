'use client';

import { Banner, Button, CheckboxRow, TextField } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { FocusHeading } from './focus-heading.tsx';
import { useLinkToken } from './link-token.ts';
import { formErrorKey, passwordRuleKey } from './messages-for-errors.ts';
import { ProblemBanner } from './problem-banner.tsx';
import { SetupQr } from './setup-qr.tsx';

interface Enrolment {
  readonly secret: string;
  readonly otpauthUri: string;
  readonly tag: string;
  readonly expiresAt: string;
}

type Step = 'details' | 'secret' | 'codes';
type Problem = { key: string; values?: Record<string, string | number> };

/** The secret as groups of four, for typing into an authenticator app by hand. */
function grouped(secret: string): string {
  return secret
    .replace(/\s/g, '')
    .replace(/(.{4})/g, '$1 ')
    .trim();
}

/**
 * Accepting an admin invitation (identity ux A9 admin variant with the A8 steps inside it, F6
 * steps 1 to 4; Hassan 6). Step 1 name and password, step 2 the authenticator app's secret and
 * the first code, step 3 the ten recovery codes shown once. The invitation token, the secret and
 * the codes live in memory only: never in the URL, storage or a log. No session is opened.
 */
export function AcceptInvitationFlow({
  passwordMin,
  passwordMax,
}: {
  readonly passwordMin: number;
  readonly passwordMax: number;
}) {
  const t = useTranslations('identity');
  const router = useRouter();
  const link = useLinkToken();
  const inFlight = useRef(false);
  const [step, setStep] = useState<Step>('details');
  const [rejected, setRejected] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>([]);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  // True once the admin was sent back to step 1, so the heading takes focus (ux 6).
  const [returned, setReturned] = useState(false);

  /** One request at a time, even when a button is pressed twice before a render. */
  async function single(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setProblem(null);
    try {
      await task();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function fail(failure: ApiFailure) {
    if (failure.code === 'invitation.rejected') {
      setRejected(true);
      return;
    }
    if (failure.code === 'request.busy' || failure.code === 'access.unavailable') {
      setProblem({ key: 'accept.busy' });
      return;
    }
    const key = formErrorKey(failure);
    setProblem(key ?? { key: 'unknown' });
  }

  function backToDetails() {
    setEnrolment(null);
    setCode('');
    setReturned(true);
    setStep('details');
  }

  async function fetchEnrolment(token: string): Promise<boolean> {
    const result = await callApi<Enrolment & { code: string }>(
      'POST',
      'identity/admin/invitation/enrolment',
      { token },
    );
    if (!result.ok) {
      fail(result.failure);
      return false;
    }
    const { secret, otpauthUri, tag, expiresAt } = result.body;
    setEnrolment({ secret, otpauthUri, tag, expiresAt });
    setCode('');
    setCodeError(null);
    return true;
  }

  async function continueToSecret(event: FormEvent) {
    event.preventDefault();
    if (link.state !== 'present') return;
    const trimmed = name.trim();
    setNameError(trimmed === '' ? 'validation.name.required' : null);
    setPasswordError(password === '' ? 'validation.password.required' : null);
    if (trimmed === '' || password === '') return;
    await single(async () => {
      if (await fetchEnrolment(link.token)) setStep('secret');
    });
  }

  async function accept(event: FormEvent) {
    event.preventDefault();
    if (link.state !== 'present' || enrolment === null) return;
    const normalised = code.replace(/\s/g, '');
    if (normalised === '') {
      setCodeError('validation.code.required');
      return;
    }
    setCodeError(null);
    await single(async () => {
      const result = await callApi<{ code: string; recoveryCodes: string[] }>(
        'POST',
        'identity/admin/invitation/accept',
        {
          token: link.token,
          displayName: name.trim(),
          password,
          secret: enrolment.secret,
          tag: enrolment.tag,
          expiresAt: enrolment.expiresAt,
          code: normalised,
        },
      );
      if (result.ok) {
        setRecoveryCodes(result.body.recoveryCodes);
        setEnrolment(null);
        setPassword('');
        setCode('');
        setStep('codes');
        return;
      }
      const { failure } = result;
      if (failure.code === 'invitation.enrolment-expired') {
        if (await fetchEnrolment(link.token)) setProblem({ key: 'accept.enrolment-expired' });
        else backToDetails();
        return;
      }
      if (failure.code === 'second-factor.invalid') {
        setCodeError('second-factor.code-rejected');
        return;
      }
      if (failure.code === 'password.rejected') {
        setPasswordError(passwordRuleKey(failure));
        backToDetails();
        return;
      }
      if (failure.code === 'second-factor.locked') {
        backToDetails();
        setProblem({ key: 'accept.locked' });
        return;
      }
      if (failure.code === 'validation.failed') {
        const paths = (failure.details?.fields ?? []).map((field) => field.path);
        if (paths.includes('displayName')) {
          setNameError('validation.name.invalid');
          backToDetails();
          return;
        }
        if (paths.includes('code')) {
          setCodeError('validation.code.required');
          return;
        }
      }
      fail(failure);
    });
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function copyKey() {
    if (enrolment === null) return;
    try {
      await navigator.clipboard.writeText(enrolment.secret);
      setKeyCopied(true);
    } catch {
      setKeyCopied(false);
    }
  }

  function downloadCodes() {
    const url = URL.createObjectURL(
      new Blob([`${recoveryCodes.join('\n')}\n`], { type: 'text/plain' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'mondapac-recovery-codes.txt';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (link.state === 'checking') {
    return (
      <p role="status" className="text-fg-muted">
        {t('accept.status.checking')}
      </p>
    );
  }
  if (link.state === 'missing' || rejected) {
    return (
      <div className="flex flex-col gap-5">
        <FocusHeading>{t('accept.rejected.title')}</FocusHeading>
        <p className="text-fg-secondary">{t('accept.rejected.body')}</p>
        <Link href="/sign-in" className="text-sm text-link hover:underline">
          {t('common.action.back-to-sign-in')}
        </Link>
      </div>
    );
  }

  const problemMessage = problem === null ? null : t(`error.${problem.key}`, problem.values);

  if (step === 'details') {
    return (
      <form
        onSubmit={(event) => void continueToSecret(event)}
        noValidate
        className="flex flex-col gap-5"
      >
        {returned ? <FocusHeading>{t('accept.details.title')}</FocusHeading> : null}
        <p className="text-fg-secondary">{t('accept.details.body')}</p>
        {problemMessage ? <ProblemBanner message={problemMessage} /> : null}
        <TextField
          label={t('accept.label.name')}
          name="name"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={nameError ? t(`error.${nameError}`) : undefined}
        />
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
          {t('accept.action.continue')}
        </Button>
      </form>
    );
  }

  if (step === 'secret' && enrolment !== null) {
    return (
      <form onSubmit={(event) => void accept(event)} noValidate className="flex flex-col gap-5">
        <FocusHeading key={enrolment.tag}>{t('accept.secret.title')}</FocusHeading>
        <p className="text-fg-secondary">{t('accept.secret.body')}</p>
        {problemMessage ? <ProblemBanner message={problemMessage} /> : null}
        <div className="flex flex-col gap-3 rounded-md border border-border p-4">
          {enrolment.otpauthUri.startsWith('otpauth://') ? (
            <SetupQr
              uri={enrolment.otpauthUri}
              label={t('accept.secret.qr-label')}
              intro={t('accept.secret.scan')}
              fallback={t('accept.secret.cannot-scan')}
            />
          ) : null}
          <span className="text-sm text-fg-muted">{t('accept.secret.key-label')}</span>
          <code dir="ltr" className="font-mono text-base break-all">
            {grouped(enrolment.secret)}
          </code>
          <div className="flex flex-wrap items-center gap-4">
            <Button type="button" variant="secondary" onClick={() => void copyKey()}>
              {keyCopied ? t('accept.codes.copied') : t('accept.codes.copy')}
            </Button>
            {enrolment.otpauthUri.startsWith('otpauth://') ? (
              <a href={enrolment.otpauthUri} className="text-sm text-link hover:underline">
                {t('accept.secret.open-app')}
              </a>
            ) : null}
          </div>
        </div>
        <TextField
          label={t('two-step.label.code')}
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          error={codeError ? t(`error.${codeError}`) : undefined}
        />
        <p className="text-sm text-fg-muted">{t('accept.secret.required')}</p>
        <Button type="submit" block loading={pending}>
          {t('two-step.action.verify')}
        </Button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <FocusHeading>{t('accept.codes.title')}</FocusHeading>
      <p className="text-fg-secondary">{t('accept.codes.body')}</p>
      <ul
        dir="ltr"
        className="grid grid-cols-2 gap-2 rounded-md border border-border p-4 font-mono"
      >
        {recoveryCodes.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => void copyCodes()}>
          {copied ? t('accept.codes.copied') : t('accept.codes.copy')}
        </Button>
        <Button type="button" variant="secondary" onClick={downloadCodes}>
          {t('accept.codes.download')}
        </Button>
        <Button type="button" variant="secondary" onClick={() => window.print()}>
          {t('accept.codes.print')}
        </Button>
      </div>
      <CheckboxRow
        label={t('accept.codes.saved')}
        checked={saved}
        onChange={(event) => setSaved(event.target.checked)}
      />
      <Banner tone="info">{t('accept.codes.once')}</Banner>
      <Button
        type="button"
        block
        disabled={!saved}
        onClick={() => router.replace('/sign-in?notice=account-ready')}
      >
        {t('accept.action.finish')}
      </Button>
    </div>
  );
}
