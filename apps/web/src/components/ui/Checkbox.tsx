import type { InputHTMLAttributes } from 'react';
import { clsx } from 'clsx';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  readonly label?: string;
  readonly description?: string;
  readonly invalid?: boolean;
}

/** Checkbox with optional label/description; entire row is clickable. */
export function Checkbox({ label, description, invalid = false, id, className, ...rest }: CheckboxProps) {
  const inputId = id ?? (label !== undefined ? `checkbox-${label}` : undefined);
  return (
    <label
      htmlFor={inputId}
      className={clsx(
        'flex cursor-pointer items-start gap-2 text-sm text-slate-700 dark:text-slate-200',
        rest.disabled === true && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <input
        id={inputId}
        type="checkbox"
        className={clsx(
          'mt-0.5 size-4 shrink-0 rounded border-slate-300 text-brand-700',
          'focus:ring-2 focus:ring-brand-600/30',
          invalid && 'border-red-500',
        )}
        aria-invalid={invalid || undefined}
        {...rest}
      />
      {(label !== undefined || description !== undefined) && (
        <span>
          {label !== undefined && <span className="block">{label}</span>}
          {description !== undefined && (
            <span className="block text-xs text-slate-500 dark:text-slate-400">{description}</span>
          )}
        </span>
      )}
    </label>
  );
}
