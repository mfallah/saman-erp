import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { clsx } from 'clsx';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly invalid?: boolean;
  readonly startIcon?: ReactNode;
  readonly endIcon?: ReactNode;
  readonly ref?: Ref<HTMLInputElement>;
}

/** Text input with optional adornments and invalid styling. */
export function Input({ invalid = false, startIcon, endIcon, className, ref, ...rest }: InputProps) {
  return (
    <div className="relative flex items-center">
      {startIcon !== undefined && (
        <span aria-hidden className="pointer-events-none absolute start-3 text-slate-400">
          {startIcon}
        </span>
      )}
      <input
        ref={ref}
        className={clsx(
          'h-10 w-full rounded-lg border bg-white px-3 text-sm text-slate-900 shadow-sm transition-colors',
          'placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20',
          'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500',
          'dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500',
          startIcon !== undefined && 'ps-10',
          endIcon !== undefined && 'pe-10',
          invalid
            ? 'border-red-500 focus:border-red-600 focus:ring-red-600/20'
            : 'border-slate-300 dark:border-slate-600',
          className,
        )}
        aria-invalid={invalid || undefined}
        {...rest}
      />
      {endIcon !== undefined && (
        <span className="absolute end-2 text-slate-400">{endIcon}</span>
      )}
    </div>
  );
}
