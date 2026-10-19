import { AlertOctagon, RefreshCw } from 'lucide-react';
import { ApiError, toFaErrorMessage } from '../../lib/api-client';
import { Button } from './Button';
import { InDevelopmentState } from './EmptyState';

export interface ErrorStateProps {
  readonly title?: string;
  readonly message?: string;
  readonly error?: unknown;
  readonly onRetry?: (() => void) | undefined;
  readonly requestId?: string;
}

/**
 * Persian, user-safe error panel. A `501 NOT_IMPLEMENTED` error is rendered as
 * the honest "در حال توسعه" state rather than a failure.
 */
export function ErrorState({
  title = 'خطا در دریافت اطلاعات',
  message,
  error,
  onRetry,
  requestId,
}: ErrorStateProps) {
  if (error instanceof ApiError && error.code === 'NOT_IMPLEMENTED') {
    return <InDevelopmentState />;
  }
  const detail = message ?? (error === undefined ? undefined : toFaErrorMessage(error));
  const request = requestId ?? (error instanceof ApiError ? error.requestId : undefined);
  const forbidden = error instanceof ApiError && (error.status === 403 || error.code === 'SCOPE_DENIED');
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50/60 px-4 py-8 text-center dark:border-red-900 dark:bg-red-950/30"
    >
      <span aria-hidden className="text-red-500">
        <AlertOctagon className="size-9" />
      </span>
      <p className="text-sm font-semibold text-red-900 dark:text-red-200">
        {forbidden ? 'دسترسی به این اطلاعات مجاز نیست' : title}
      </p>
      {detail !== undefined && (
        <p className="max-w-lg text-xs text-red-800/80 dark:text-red-300/80">{detail}</p>
      )}
      {request !== undefined && (
        <p className="text-[11px] text-red-700/60 dark:text-red-400/60" dir="ltr">
          {request}
        </p>
      )}
      {onRetry !== undefined && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          icon={<RefreshCw aria-hidden className="size-4" />}
        >
          تلاش مجدد
        </Button>
      )}
    </div>
  );
}
