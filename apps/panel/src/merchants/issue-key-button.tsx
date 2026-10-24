'use client';

import { Banner, Button, Dialog } from '@mondapac-drive/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormButton } from '../ops/form-button.tsx';
import { formatInstant } from '../shared/format.ts';
import type { ApiKeyIssued } from '../ops/types.ts';

/**
 * "Issue API key" (identity.merchant-api-key.issue) with the copy-once dialog: the answer's key
 * lives only in this component's state while the dialog is open. It is never written to the
 * URL, storage, the notice or a log, and closing the dialog drops it; the API keeps only its
 * hash, so it cannot be shown again.
 */
export function IssueKeyButton({
  merchantId,
  csrfToken,
}: {
  readonly merchantId: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('merchants.keys');
  const ops = useTranslations('ops');
  const locale = useLocale();
  const [issued, setIssued] = useState<ApiKeyIssued | null>(null);
  const [copied, setCopied] = useState(false);

  async function copy(key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const close = () => {
    setIssued(null);
    setCopied(false);
  };

  return (
    <>
      <FormButton<ApiKeyIssued>
        copy={{
          button: t('issue.button'),
          title: t('issue.title'),
          label: t('issue.label'),
          help: t('issue.help'),
          action: t('issue.action'),
          cancel: ops('cancel'),
          done: () => '',
        }}
        path={`identity/admin/merchants/${merchantId}/api-keys`}
        field="label"
        maxLength={64}
        csrfToken={csrfToken}
        onDone={(answer) => setIssued(answer)}
      />
      <Dialog
        open={issued !== null}
        title={t('issued.title')}
        onClose={close}
        actions={<Button onClick={close}>{t('issued.done')}</Button>}
      >
        {issued === null ? null : (
          <div className="flex flex-col gap-4">
            <Banner tone="attention">{t('issued.body')}</Banner>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium" id="issued-key-label">
                {t('issued.label')}
              </span>
              <output
                aria-labelledby="issued-key-label"
                className="block select-all break-all rounded-md border border-line bg-muted p-3 font-mono text-sm"
                data-testid="issued-key"
              >
                {issued.key}
              </output>
              <p className="text-sm text-fg-muted">
                {t('issued.expires', { when: formatInstant(issued.expiresAt, locale) })}
              </p>
            </div>
            <div>
              <Button variant="secondary" onClick={() => void copy(issued.key)}>
                {copied ? t('issued.copied') : t('issued.copy')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
