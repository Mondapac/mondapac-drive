'use client';

import { Banner, Button, Card, TextField } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { nameProblemOf, type Problem } from './errors.ts';

const MAX_LENGTH = 100;

/** The signed-in user's own display name: edit and save. */
export function DisplayNameCard({
  initial,
  csrfToken,
}: {
  readonly initial: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('profile');
  const router = useRouter();
  const [text, setText] = useState(initial);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saved, setSaved] = useState<'changed' | 'same' | null>(null);
  const busy = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  function focusInvalid() {
    queueMicrotask(() =>
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    setSaved(null);
    setProblem(null);
    const name = text.trim();
    if (name === '' || [...name].length > MAX_LENGTH) {
      setProblem({ key: 'name-length', field: 'name' });
      focusInvalid();
      return;
    }
    busy.current = true;
    setPending(true);
    const result = await callApi<{ readonly changed: boolean }>(
      'PUT',
      'identity/admin/profile/display-name',
      { displayName: name },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setText(name);
      setSaved(result.body.changed ? 'changed' : 'same');
      // The details card and the account menu read the name on the server.
      if (result.body.changed) router.refresh();
      return;
    }
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else {
      setProblem(nameProblemOf(result.failure));
      focusInvalid();
    }
  }

  const fieldError = problem?.field === 'name' ? t(`error.${problem.key}`) : undefined;
  return (
    <Card title={t('name-title')}>
      <form
        ref={formRef}
        className="flex flex-col gap-4 sm:max-w-md"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {saved === null ? null : (
          <Banner tone="success">{t(saved === 'changed' ? 'name-saved' : 'name-same')}</Banner>
        )}
        {problem === null || problem.field !== null ? null : (
          <Banner tone="critical">{t(`error.${problem.key}`, problem.values)}</Banner>
        )}
        <TextField
          name="displayName"
          label={t('name-label')}
          help={t('name-help')}
          autoComplete="name"
          // Twice the limit: the limit counts characters, the browser counts UTF-16 units.
          maxLength={MAX_LENGTH * 2}
          value={text}
          error={fieldError}
          onChange={(event) => {
            setText(event.target.value);
            setSaved(null);
          }}
        />
        <div>
          <Button type="submit" loading={pending}>
            {t('name-save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
