'use client';

import { Badge, Banner, Button, Card, Dialog, Icon } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { sessionsProblemOf, type Problem } from './errors.ts';

/** One signed-in device, with its times already formatted by the page server. */
export interface SessionRow {
  readonly device: string;
  readonly signedInAt: string;
  readonly signedInLabel: string;
  readonly lastActiveAt: string;
  readonly lastActiveLabel: string;
  readonly current: boolean;
}

/**
 * The signed-in user's own devices, and "sign out of all other devices" behind a confirmation.
 * The current device stays signed in; the list is read again on the server afterwards.
 */
export function SessionsCard({
  rows,
  csrfToken,
}: {
  readonly rows: readonly SessionRow[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('sessions');
  const errorT = useTranslations('profile');
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const busy = useRef(false);
  const others = rows.filter((row) => !row.current).length;

  async function signOutOthers() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<{ readonly revokedSessions: number }>(
      'POST',
      'identity/admin/profile/sessions/sign-out-others',
      {},
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setAsking(false);
      setDone(result.body.revokedSessions);
      router.refresh();
      return;
    }
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(sessionsProblemOf(result.failure));
  }

  return (
    <Card title={t('list-title')}>
      <div className="flex flex-col gap-4">
        <p className="text-fg-secondary">{t('intro')}</p>
        {done === null ? null : (
          <Banner tone="success">{t('signed-out-others', { count: done })}</Banner>
        )}
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
          {rows.map((row, index) => (
            <li
              // The list has no ids by design: the API never answers a session id.
              key={`${row.signedInAt}-${index}`}
              className="flex min-w-0 items-start gap-3 p-4"
            >
              <Icon name="monitor" className="mt-0.5 shrink-0 text-icon-muted" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words">{row.device}</span>
                  {row.current ? <Badge tone="success">{t('this-device')}</Badge> : null}
                </div>
                <p className="text-sm text-fg-muted">
                  {t('signed-in')} <time dateTime={row.signedInAt}>{row.signedInLabel}</time>
                </p>
                <p className="text-sm text-fg-muted">
                  {row.current ? (
                    t('active-now')
                  ) : (
                    <>
                      {t('last-active')}{' '}
                      <time dateTime={row.lastActiveAt}>{row.lastActiveLabel}</time>
                    </>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ul>
        {others === 0 ? (
          <p className="text-fg-muted">{t('only-this-device')}</p>
        ) : (
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                setDone(null);
                setProblem(null);
                setAsking(true);
              }}
            >
              {t('sign-out-others')}
            </Button>
          </div>
        )}
      </div>
      <Dialog
        open={asking}
        title={t('dialog.title')}
        onClose={() => {
          if (!pending) setAsking(false);
        }}
        actions={
          <>
            <Button variant="secondary" onClick={() => setAsking(false)} disabled={pending}>
              {t('dialog.keep')}
            </Button>
            <Button variant="destructive" loading={pending} onClick={() => void signOutOthers()}>
              {t('dialog.action')}
            </Button>
          </>
        }
      >
        <p>{t('dialog.body', { count: others })}</p>
        {problem === null ? null : (
          <div className="mt-3">
            <Banner tone="critical">{errorT(`error.${problem.key}`, problem.values)}</Banner>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
