import type { SelectHTMLAttributes } from 'react';
import { clsx } from 'clsx';
import { ChevronDown } from 'lucide-react';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
  readonly invalid?: boolean;
  readonly loading?: boolean;
}

/** Native, accessible select (keyboard + screen-reader support for free). */
export function Select({
  options,
  placeholder,
  invalid = false,
  loading = false,
  className,
  disabled,
  ...rest
}: SelectProps) {
  return (
    <div className="relative">
      <select
        className={clsx(
          'h-10 w-full appearance-none rounded-lg border bg-white px-3 pe-9 text-sm text-slate-900 shadow-sm',
          'focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20',
          'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500',
          'dark:bg-slate-900 dark:text-slate-100 dark:border-slate-600',
          invalid ? 'border-red-500' : 'border-slate-300',
          className,
        )}
        disabled={disabled === true || loading}
        aria-invalid={invalid || undefined}
        {...rest}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
      />
    </div>
  );
}
