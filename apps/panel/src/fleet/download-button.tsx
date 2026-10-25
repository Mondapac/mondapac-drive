'use client';

import { Button } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { messageFor } from '../ops/errors.ts';
import { useNotice } from '../ops/notice.tsx';

const EXTENSION: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

/**
 * Saves a courier's document (`fleet.document.review`; the API audits each download). The file
 * is read with the session cookie and saved from memory: never opened in a tab, never cached,
 * and its object URL is released a moment later. The file name is the document's id, not its type.
 */
export function DownloadButton({
  courierId,
  documentId,
  label,
  name,
}: {
  readonly courierId: string;
  readonly documentId: string;
  readonly label: string;
  /** The accessible name when several rows show the same label; it starts with the label. */
  readonly name?: string;
}) {
  const t = useTranslations();
  const notify = useNotice();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  async function download(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const response = await fetch(
        `/api/fleet/admin/couriers/${courierId}/documents/${documentId}/file`,
        { credentials: 'same-origin', cache: 'no-store' },
      );
      if (!response.ok) {
        const body = (await response.json().catch((): unknown => null)) as {
          code?: unknown;
        } | null;
        const code = typeof body?.code === 'string' ? body.code : 'unknown';
        notify({ tone: 'critical', text: messageFor(t, code, 'fleet') });
        return;
      }
      // Only the document types the API stores; the saved file is plain bytes, so it can never
      // open as a page of the panel's origin (security review, L2).
      const extension = EXTENSION[(response.headers.get('content-type') ?? '').split(';')[0] ?? ''];
      if (extension === undefined) {
        await response.body?.cancel();
        notify({ tone: 'critical', text: messageFor(t, 'unknown', 'fleet') });
        return;
      }
      const blob = new Blob([await response.arrayBuffer()], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${documentId}.${extension}`;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      // Some browsers start the save after the click returns; release the file just after.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      notify({ tone: 'critical', text: messageFor(t, 'network', 'fleet') });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <Button variant="secondary" loading={pending} aria-label={name} onClick={() => void download()}>
      {label}
    </Button>
  );
}
