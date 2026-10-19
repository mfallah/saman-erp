import type { ReactNode } from 'react';
import { Inbox, Wrench } from 'lucide-react';

export interface EmptyStateProps {
  readonly title?: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly icon?: ReactNode;
}

/** Neutral empty state (only shown after a successful, empty response). */
export function EmptyState({
  title = 'داده‌ای برای نمایش وجود ندارد',
  description,
  action,
  icon,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <span className="text-slate-300 dark:text-slate-600" aria-hidden>
        {icon ?? <Inbox className="size-10" />}
      </span>
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {description !== undefined && (
        <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">{description}</p>
      )}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * Honest placeholder for API capabilities marked `501 NOT_IMPLEMENTED` or not
 * yet shipped. It never pretends an operation succeeded.
 */
export function InDevelopmentState({
  title = 'در حال توسعه',
  description = 'این بخش هنوز در نسخه فعلی سامانه فعال نشده است و به‌زودی در دسترس قرار می‌گیرد.',
  action,
}: {
  readonly title?: string;
  readonly description?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-amber-300 bg-amber-50/60 px-4 py-10 text-center dark:border-amber-800 dark:bg-amber-950/30">
      <span aria-hidden className="text-amber-500">
        <Wrench className="size-10" />
      </span>
      <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">{title}</p>
      <p className="max-w-md text-xs text-amber-800/80 dark:text-amber-300/80">{description}</p>
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}
