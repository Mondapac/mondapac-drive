'use client';

import { useEffect, useState } from 'react';

/** True until `seconds` have passed after `start(seconds)` is called; then false again. */
export function useThrottle(): { blocked: boolean; start: (seconds: number) => void } {
  const [until, setUntil] = useState<number | null>(null);
  useEffect(() => {
    if (until === null) return undefined;
    const timer = setTimeout(() => setUntil(null), Math.max(0, until - performance.now()));
    return () => clearTimeout(timer);
  }, [until]);
  return {
    blocked: until !== null,
    start: (seconds) => setUntil(performance.now() + seconds * 1000),
  };
}
