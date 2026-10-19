import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { formatMoney, parseMoney, toLatinDigits } from '../../lib/money';

export interface MoneyInputProps {
  readonly id?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly invalid?: boolean;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly ariaDescribedBy?: string;
}

/**
 * Money input (IRR). While editing, the raw digit string is exposed to the
 * parent; when blurred the value is rendered with Persian grouping. Parsing goes
 * through `parseMoney` (bigint), never `parseFloat`.
 */
export function MoneyInput({
  id,
  value,
  onChange,
  placeholder = '۰',
  invalid = false,
  disabled = false,
  required = false,
  className,
  ariaLabel,
  ariaDescribedBy,
}: MoneyInputProps) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  const [localError, setLocalError] = useState(false);

  useEffect(() => {
    if (!focused) {
      setDraft(value);
    }
  }, [value, focused]);

  const display = focused
    ? draft
    : (() => {
        if (value === '') {
          return '';
        }
        try {
          return formatMoney(value, { unit: '' });
        } catch {
          return value;
        }
      })();

  return (
    <div className={clsx('relative flex items-center', className)}>
      <input
        id={id}
        value={display}
        inputMode="numeric"
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
            setLocalError(false);
            return;
          }
          try {
            onChange(parseMoney(draft).toString());
            setLocalError(false);
          } catch {
            setLocalError(true);
          }
        }}
        onChange={(event) => {
          const normalized = toLatinDigits(event.target.value).replace(/[\s\u066c,]/g, '');
          if (!/^-?\d*$/.test(normalized)) {
            setLocalError(true);
            return;
          }
          setLocalError(false);
          setDraft(normalized);
          onChange(normalized);
        }}
        className={clsx(
          'h-10 w-full rounded-lg border bg-white px-3 text-left text-sm tabular text-slate-900 shadow-sm',
          'focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20',
          'disabled:cursor-not-allowed disabled:bg-slate-50 dark:bg-slate-900 dark:text-slate-100',
          invalid || localError
            ? 'border-red-500 focus:border-red-600 focus:ring-red-600/20'
            : 'border-slate-300 dark:border-slate-600',
        )}
      />
      <span className="pointer-events-none absolute end-3 text-xs text-slate-400">ریال</span>
    </div>
  );
}
