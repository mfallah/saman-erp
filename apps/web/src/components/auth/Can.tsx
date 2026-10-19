import type { ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useHasPermission } from '../../lib/use-auth';

export interface CanProps {
  readonly permission: string;
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}

/** Hides an action when the caller lacks the permission key (default-deny). */
export function Can({ permission, children, fallback = null }: CanProps) {
  const allowed = useHasPermission(permission);
  return <>{allowed ? children : fallback}</>;
}

/** Inline notice for a screen opened without its read permission. */
export function PermissionNotice({ permission }: { readonly permission: string }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <ShieldAlert aria-hidden className="size-5 shrink-0" />
      <span>
        برای مشاهده این بخش به دسترسی <code dir="ltr">{permission}</code> نیاز دارید.
      </span>
    </div>
  );
}
