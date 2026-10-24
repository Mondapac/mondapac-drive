'use client';

import { useEffect, type RefObject } from 'react';

/**
 * After a failed submit, moves focus to the first invalid field; its error text is read through
 * `aria-describedby` (identity ux 3.0 rule 3, section 6).
 */
export function useFocusFirstInvalid(
  form: RefObject<HTMLFormElement | null>,
  errors: Readonly<Record<string, string>>,
): void {
  useEffect(() => {
    if (Object.keys(errors).length === 0) return;
    const root = form.current;
    (
      root?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      root?.querySelector<HTMLElement>('[data-form-problem]')
    )?.focus();
  }, [form, errors]);
}
