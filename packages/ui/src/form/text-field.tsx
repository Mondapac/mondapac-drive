'use client';

import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'aria-describedby' | 'aria-invalid'
> {
  readonly label: string;
  /** Help text under the input. */
  readonly help?: ReactNode;
  /** Error text; setting it marks the field invalid. */
  readonly error?: string | undefined;
  /** Fixed text before the value, shown inside the control (a storefront address). Left-to-right. */
  readonly prefix?: string;
  /** A status line under the control (a `FieldStatus`); it is part of the field's description. */
  readonly status?: ReactNode;
  /** Marks the label "(optional)"; the text is the Market-neutral word from the caller. */
  readonly optionalLabel?: string;
  /** Password fields get a show/hide toggle; these are its labels. */
  readonly showLabel?: string;
  readonly hideLabel?: string;
}

/** A labelled input with help and error text wired through aria-describedby (WCAG 2.2 AA). */
export function TextField({
  label,
  help,
  error,
  showLabel,
  hideLabel,
  prefix,
  status,
  optionalLabel,
  type = 'text',
  className,
  ...rest
}: TextFieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const statusId = `${id}-status`;
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === 'password' && showLabel !== undefined && hideLabel !== undefined;
  const describedBy = [help ? helpId : null, status ? statusId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
        {optionalLabel ? (
          <span className="font-normal text-fg-muted"> ({optionalLabel})</span>
        ) : null}
      </label>
      <div className="relative flex items-center">
        {prefix ? (
          <span
            dir="ltr"
            className="flex h-(--mp-size-control) items-center rounded-s-md border border-e-0 border-line-input bg-subtle px-3 text-fg-muted"
          >
            {prefix}
          </span>
        ) : null}
        <input
          id={id}
          type={isPassword && revealed ? 'text' : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={[
            'h-(--mp-size-control) w-full border bg-surface px-3 text-fg',
            prefix ? 'rounded-e-md' : 'rounded-md',
            error ? 'border-critical-solid' : 'border-line-input',
            isPassword ? 'pe-20' : '',
            className ?? '',
          ]
            .filter(Boolean)
            .join(' ')}
          {...rest}
        />
        {isPassword ? (
          <button
            type="button"
            onClick={() => setRevealed((value) => !value)}
            aria-controls={id}
            className="absolute inset-y-0 end-0 px-3 text-sm font-medium text-link"
          >
            {revealed ? hideLabel : showLabel}
          </button>
        ) : null}
      </div>
      {help ? (
        <p id={helpId} className="text-sm text-fg-muted">
          {help}
        </p>
      ) : null}
      {status ? <div id={statusId}>{status}</div> : null}
      {error ? (
        <p id={errorId} className="text-sm text-critical-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
