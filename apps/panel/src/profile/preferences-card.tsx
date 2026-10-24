'use client';

import { Banner, Button, Card, Select } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { PANEL_LANGUAGES } from './languages.ts';
import { preferencesProblemOf, type Problem } from './errors.ts';

/** The signed-in user's own time zone and language: choose and save. */
export function PreferencesCard({
  timezone,
  locale,
  zones,
  csrfToken,
}: {
  readonly timezone: string | null;
  readonly locale: string | null;
  /** IANA zone ids, read on the server so the list is the same on both sides. */
  readonly zones: readonly string[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('profile');
  const router = useRouter();
  const [zone, setZone] = useState(timezone ?? '');
  const [language, setLanguage] = useState(locale ?? '');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saved, setSaved] = useState<'changed' | 'same' | null>(null);
  const busy = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    setSaved(null);
    setProblem(null);
    busy.current = true;
    setPending(true);
    const result = await callApi<{ readonly changed: boolean }>(
      'PUT',
      'identity/admin/profile/preferences',
      { timezone: zone === '' ? null : zone, locale: language === '' ? null : language },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setSaved(result.body.changed ? 'changed' : 'same');
      // The details card reads the choice on the server.
      if (result.body.changed) router.refresh();
      return;
    }
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(preferencesProblemOf(result.failure));
  }

  return (
    <Card title={t('prefs-title')}>
      <form
        className="flex flex-col gap-4 sm:max-w-md"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <p className="text-sm text-fg-muted">{t('prefs-intro-admin')}</p>
        {saved === null ? null : (
          <Banner tone="success">{t(saved === 'changed' ? 'prefs-saved' : 'prefs-same')}</Banner>
        )}
        {problem === null ? null : <Banner tone="critical">{t(`error.${problem.key}`)}</Banner>}
        <Select
          name="timezone"
          label={t('timezone-label')}
          help={t('timezone-help-admin')}
          value={zone}
          options={[
            { value: '', label: t('timezone-default-admin') },
            ...zones.map((id) => ({ value: id, label: id.replaceAll('_', ' ') })),
          ]}
          onChange={(event) => {
            setZone(event.target.value);
            setSaved(null);
          }}
        />
        <Select
          name="locale"
          label={t('language-label')}
          help={t('language-help')}
          value={language}
          options={[
            { value: '', label: t('language-default') },
            ...PANEL_LANGUAGES.map((code) => ({ value: code, label: t(`language-${code}`) })),
          ]}
          onChange={(event) => {
            setLanguage(event.target.value);
            setSaved(null);
          }}
        />
        <div>
          <Button type="submit" loading={pending}>
            {t('prefs-save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
