import { clsx } from 'clsx';

/** Loading placeholder block with animation. */
export function Skeleton({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx('block animate-pulse rounded bg-slate-200 dark:bg-slate-700', className)}
    />
  );
}

/** Multiple text lines of skeleton, used while a panel loads. */
export function SkeletonText({ lines = 3 }: { readonly lines?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="در حال بارگذاری">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={clsx('h-4', index === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}
