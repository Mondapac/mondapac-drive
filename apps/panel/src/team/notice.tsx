'use client';

import { Banner } from '@mondapac-drive/ui';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface Notice {
  readonly tone: 'success' | 'critical';
  readonly text: string;
}

const NoticeContext = createContext<(notice: Notice) => void>(() => undefined);

/** One polite live region for the outcome of the last row action (the "Toast" of ux D3). */
export function NoticeProvider({ children }: { readonly children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const show = useCallback((next: Notice) => setNotice(next), []);
  const value = useMemo(() => show, [show]);
  return (
    <NoticeContext.Provider value={value}>
      <div role="status" aria-live="polite" className="mb-4 empty:hidden">
        {notice === null ? null : (
          <Banner tone={notice.tone === 'success' ? 'success' : 'critical'}>{notice.text}</Banner>
        )}
      </div>
      {children}
    </NoticeContext.Provider>
  );
}

export const useNotice = () => useContext(NoticeContext);
