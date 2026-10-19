import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { Skeleton } from './Skeleton';

export type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'brand';

const TONE_RING: Record<StatTone, string> = {
  default: 'text-slate-500',
  success: 'text-emerald-600',
  warning: 'text-amber-600',
  danger: 'text-red-600',
  brand: 'text-brand-700',
};

export interface StatCardProps {
  readonly title: string;
  readonly value: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
  readonly tone?: StatTone;
  readonly loading?: boolean;
}

/** KPI card used by the dashboard; values are pre-formatted Persian strings. */
export function StatCard({ title, value, hint, icon, tone = 'default', loading = false }: StatCardProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{title}</p>
        {icon !== undefined && <span className={clsx('shrink-0', TONE_RING[tone])}>{icon}</span>}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-28" />
      ) : (
        <p className="mt-2 text-lg font-bold text-slate-900 tabular dark:text-slate-100">{value}</p>
      )}
      {hint !== undefined && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>
      )}
    </div>
  );
}
