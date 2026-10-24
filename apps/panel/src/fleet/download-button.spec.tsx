// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { NoticeProvider } from '../ops/notice.tsx';
import { DownloadButton } from './download-button.tsx';

const COURIER = '0190a000-0000-7000-8000-0000000000c1';
const DOCUMENT = '0190a000-0000-7000-8000-0000000000d2';

function show() {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <NoticeProvider>
        <DownloadButton courierId={COURIER} documentId={DOCUMENT} label="Download" />
      </NoticeProvider>
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Download' }));
}

const saved: string[] = [];
beforeEach(() => {
  saved.length = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:file'),
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(
    this: HTMLAnchorElement,
  ) {
    saved.push(this.download);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('document download', () => {
  it('reads the file through the relay and saves it under the document id', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(new Blob(['%PDF'], { type: 'application/pdf' }), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    show();
    await waitFor(() => expect(saved).toEqual([`${DOCUMENT}.pdf`]));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/fleet/admin/couriers/${COURIER}/documents/${DOCUMENT}/file`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'same-origin',
      cache: 'no-store',
    });
  });

  it('refuses a file of a type the API never stores, and saves nothing', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response('<script>alert(1)</script>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    show();
    expect(await screen.findByText(messages.ops.error.unknown)).toBeTruthy();
    expect(saved).toEqual([]);
  });

  it('shows why a download was refused, and saves nothing', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 'fleet.storage-unavailable' }), { status: 503 }),
      ),
    );
    show();
    expect(
      await screen.findByText("Document storage isn't available right now. Try again shortly."),
    ).toBeTruthy();
    expect(saved).toEqual([]);
  });
});
