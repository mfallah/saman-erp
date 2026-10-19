import type { InputHTMLAttributes } from 'react';
import { clsx } from 'clsx';

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'> {
  readonly label?: string;
  readonly description?: string;
}

/** Toggle switch; uses a real checkbox for accessibility. */
export function Switch({ label, description, id, className, ...rest }: SwitchProps) {
  const inputId = id ?? (label !== undefined ? `switch-${label}` : undefined);
  return (
    <label
      htmlFor={inputId}
      className={clsx(
        'flex cursor-pointer items-center justify-between gap-3 text-sm text-slate-700 dark:text-slate-200',
        rest.disabled === true && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <span>
        {label !== undefined && <span className="block">{label}</span>}
        {description !== undefined && (
          <span className="block text-xs text-slate-500 dark:text-slate-400">{description}</span>
        )}
      </span>
      <span className="relative inline-flex shrink-0 items-center">
        <input id={inputId} type="checkbox" className="peer sr-only" {...rest} />
        <span
          aria-hidden
          className="h-6 w-11 rounded-full bg-slate-300 transition-colors peer-checked:bg-brand-700 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-600 dark:bg-slate-600"
        />
        <span
          aria-hidden
          className="absolute start-0.5 size-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-[-1.25rem] rtl:peer-checked:translate-x-[-1.25rem]"
        />
      </span>
    </label>
  );
}
