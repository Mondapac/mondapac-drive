'use client';

import { useEffect, useState } from 'react';

/** Counts a Retry-After down to zero, one second at a time: `[secondsLeft, start]`. */
export function useCountdown(): [number, (seconds: number) => void] {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  return [left, setLeft];
}
