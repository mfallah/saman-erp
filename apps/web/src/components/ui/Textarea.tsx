import type { TextareaHTMLAttributes } from 'react';
import { clsx } from 'clsx';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly invalid?: boolean;
}

/** Multi-line text input with the same visual language as `Input`. */
export function Textarea({ invalid = false, className, rows = 4, ...rest }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      className={clsx(
        'w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors',
        'placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20',
        'dark:bg-slate-900 dark:text-slate-100',
        invalid
          ? 'border-red-500 focus:border-red-600 focus:ring-red-600/20'
          : 'border-slate-300 dark:border-slate-600',
        className,
      )}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}
