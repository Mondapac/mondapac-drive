'use client';

import { useId, type InputHTMLAttributes } from 'react';

export interface CheckboxRowProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type' | 'aria-describedby'
> {
  readonly label: string;
  readonly help?: string;
}

/** One checkbox with its label (and help) as a single click target. */
export function CheckboxRow({ label, help, ...rest }: CheckboxRowProps) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        aria-describedby={help ? helpId : undefined}
        className="mt-1 size-4 accent-accent"
        {...rest}
      />
      <div className="flex flex-col">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {help ? (
          <p id={helpId} className="text-sm text-fg-muted">
            {help}
          </p>
        ) : null}
      </div>
    </div>
  );
}
