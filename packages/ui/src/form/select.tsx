'use client';

import { useId, type SelectHTMLAttributes } from 'react';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'id' | 'aria-describedby' | 'aria-invalid' | 'children'
> {
  readonly label: string;
  readonly options: readonly SelectOption[];
  /** Text of the empty first option, when the field starts with no choice. */
  readonly placeholder?: string;
  readonly help?: string;
  readonly error?: string | undefined;
}

/** A labelled native select with help and error text wired through aria-describedby. */
export function Select({
  label,
  options,
  placeholder,
  help,
  error,
  className,
  ...rest
}: SelectProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </label>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={[
          'h-(--mp-size-control) w-full rounded-md border bg-surface px-3 text-fg',
          error ? 'border-critical-solid' : 'border-line-input',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
        {...rest}
      >
        {placeholder === undefined ? null : <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {help ? (
        <p id={helpId} className="text-sm text-fg-muted">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-critical-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
