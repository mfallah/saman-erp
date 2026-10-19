import type { HTMLAttributes, ReactNode } from 'react';
import { clsx } from 'clsx';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  readonly padding?: 'none' | 'sm' | 'md';
}

/** Surface container used across screens. */
export function Card({ padding = 'md', className, children, ...rest }: CardProps) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900',
        padding === 'md' && 'p-4',
        padding === 'sm' && 'p-3',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={clsx('mb-3 flex items-start justify-between gap-3', className)}>
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
        {description !== undefined && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardContent({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={className}>{children}</div>;
}

export function CardFooter({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <div className={clsx('mt-3 flex items-center justify-end gap-2 border-t border-slate-100 pt-3 dark:border-slate-800', className)}>
      {children}
    </div>
  );
}
