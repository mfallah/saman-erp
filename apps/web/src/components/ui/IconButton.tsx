import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';

export type IconButtonTone = 'default' | 'danger';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name; icon-only buttons must always have one. */
  readonly label: string;
  readonly icon: ReactNode;
  readonly tone?: IconButtonTone;
  readonly loading?: boolean;
  readonly size?: 'sm' | 'md' | 'lg';
}

const SIZE = { sm: 'size-8', md: 'size-10', lg: 'size-12' } as const;

/** Icon-only button; `label` is mandatory and becomes `aria-label`. */
export function IconButton({
  label,
  icon,
  tone = 'default',
  loading = false,
  size = 'md',
  className,
  disabled,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex items-center justify-center rounded-lg transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
        'disabled:cursor-not-allowed disabled:opacity-60',
        tone === 'danger'
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950'
          : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
        SIZE[size],
        className,
      )}
      disabled={disabled === true || loading}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="size-5 animate-spin" /> : icon}
    </button>
  );
}
