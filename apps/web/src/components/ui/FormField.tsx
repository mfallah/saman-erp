import { useId, type ReactNode } from 'react';
import { clsx } from 'clsx';

export interface FormFieldProps {
  readonly label: string;
  readonly htmlFor?: string;
  readonly required?: boolean;
  readonly error?: string;
  readonly hint?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/** Label + hint + Persian error message wrapper for any form control. */
export function FormField({
  label,
  htmlFor,
  required = false,
  error,
  hint,
  children,
  className,
}: FormFieldProps) {
  const generatedId = useId();
  const describedBy = useId();
  const targetId = htmlFor;
  const fieldId = targetId ?? generatedId;
  return (
    <div className={clsx('space-y-1.5', className)}>
      <label
        htmlFor={fieldId}
        className="block text-sm font-medium text-slate-700 dark:text-slate-200"
      >
        {label}
        {required && (
          <span aria-hidden className="ms-1 text-red-500">
            *
          </span>
        )}
      </label>
      {children}
      {hint !== undefined && error === undefined && (
        <p id={describedBy} className="text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
