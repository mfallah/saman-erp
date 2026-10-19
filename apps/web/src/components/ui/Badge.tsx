import type { ReactNode } from 'react';
import { clsx } from 'clsx';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  danger: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
  info: 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  brand: 'bg-brand-50 text-brand-800 dark:bg-brand-900 dark:text-brand-200',
};

export interface BadgeProps {
  readonly children: ReactNode;
  readonly tone?: BadgeTone;
  readonly icon?: ReactNode;
  readonly className?: string;
}

/** Compact status pill. */
export function Badge({ children, tone = 'neutral', icon, className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** Maps document/order statuses to Persian labels and badge tones. */
const STATUS_MAP: Record<string, { label: string; tone: BadgeTone }> = {
  draft: { label: 'پیش‌نویس', tone: 'neutral' },
  submitted: { label: 'ارسال‌شده', tone: 'info' },
  confirmed: { label: 'تأییدشده', tone: 'info' },
  allocated: { label: 'تخصیص‌یافته', tone: 'brand' },
  picking: { label: 'در حال برداشت', tone: 'warning' },
  packed: { label: 'بسته‌بندی‌شده', tone: 'warning' },
  shipped: { label: 'ارسال‌شده', tone: 'success' },
  delivered: { label: 'تحویل‌شده', tone: 'success' },
  closed: { label: 'بسته‌شده', tone: 'neutral' },
  cancelled: { label: 'لغو‌شده', tone: 'danger' },
  on_hold: { label: 'در انتظار', tone: 'warning' },
  pending: { label: 'در انتظار', tone: 'warning' },
  assigned: { label: 'اختصاص‌یافته', tone: 'info' },
  in_progress: { label: 'در حال انجام', tone: 'info' },
  completed: { label: 'تکمیل‌شده', tone: 'success' },
  failed: { label: 'ناموفق', tone: 'danger' },
  posted: { label: 'ثبت‌شده', tone: 'success' },
  approved: { label: 'تأییدشده', tone: 'success' },
  rejected: { label: 'رد‌شده', tone: 'danger' },
  active: { label: 'فعال', tone: 'success' },
  inactive: { label: 'غیرفعال', tone: 'neutral' },
  archived: { label: 'بایگانی', tone: 'neutral' },
  published: { label: 'منتشرشده', tone: 'success' },
  queued: { label: 'در صف', tone: 'neutral' },
  running: { label: 'در حال اجرا', tone: 'info' },
  succeeded: { label: 'موفق', tone: 'success' },
  partial: { label: 'ناقص', tone: 'warning' },
  open: { label: 'باز', tone: 'info' },
  locked: { label: 'قفل‌شده', tone: 'neutral' },
};

export function statusLabelFa(status: string): string {
  return STATUS_MAP[status]?.label ?? status;
}

export function statusTone(status: string): BadgeTone {
  return STATUS_MAP[status]?.tone ?? 'neutral';
}

/** Status badge driven by a stable API status code. */
export function StatusBadge({ status }: { readonly status: string }) {
  return <Badge tone={statusTone(status)}>{statusLabelFa(status)}</Badge>;
}
