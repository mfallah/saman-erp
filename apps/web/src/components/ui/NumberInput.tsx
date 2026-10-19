import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { formatQuantity, toLatinDigits } from '../../lib/money';

export interface NumberInputProps {
  readonly id?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly invalid?: boolean;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly min?: string;
  readonly max?: string;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly ariaDescribedBy?: string;
}

const DECIMAL_RE = /^\d*(?:\.\d*)?$/;

/**
 * Quantity/decimal input (`numeric(18,4)` transport strings). Digits are kept
 * as strings to avoid floating-point drift; formatting happens on blur only.
 */
export function NumberInput({
  id,
  value,
  onChange,
  placeholder = '۰',
  invalid = false,
  disabled = false,
  required = false,
  min,
  max,
  className,
  ariaLabel,
  ariaDescribedBy,
}: NumberInputProps) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  const [localError, setLocalError] = useState(false);

  useEffect(() => {
    if (!focused) {
      setDraft(value);
    }
  }, [value, focused]);

  const display = focused ? draft : value === '' ? '' : formatQuantity(value);

  const isOutOfRange = (raw: string): boolean => {
    if (raw === '') {
      return false;
    }
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) {
      return true;
    }
    if (min !== undefined && numeric < Number(min)) {
      return true;
    }
    if (max !== undefined && numeric > Number(max)) {
      return true;
    }
    return false;
  };

  return (
    <input
      id={id}
      value={display}
      inputMode="decimal"
      dir="ltr"
      autoComplete="off"
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-invalid={invalid || localError || undefined}
      onFocus={() => {
        setFocused(true);
        setDraft(value);
      }}
      onBlur={() => {
        setFocused(false);
        if (draft === '') {
          onChange('');
          return;
        }
        const error = isOutOfRange(draft);
        setLocalError(error);
        if (!error) {
          onChange(draft);
        }
      }}
      onChange={(event) => {
        const normalized = toLatinDigits(event.target.value).replace(/[\s,\u066c]/g, '');
        if (!DECIMAL_RE.test(normalized)) {
          setLocalError(true);
          return;
        }
        setDraft(normalized);
        setLocalError(isOutOfRange(normalized));
        onChange(normalized);
      }}
      className={clsx(
        'h-10 w-full rounded-lg border bg-white px-3 text-left text-sm tabular text-slate-900 shadow-sm',
        'focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20',
        'disabled:cursor-not-allowed disabled:bg-slate-50 dark:bg-slate-900 dark:text-slate-100',
        invalid || localError
          ? 'border-red-500 focus:border-red-600 focus:ring-red-600/20'
          : 'border-slate-300 dark:border-slate-600',
        className,
      )}
    />
  );
}
