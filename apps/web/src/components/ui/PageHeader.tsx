import type { ReactNode } from 'react';
import { ChevronLeft, Home } from 'lucide-react';
import { Link } from '@tanstack/react-router';

export interface BreadcrumbItem {
  readonly label: string;
  readonly to?: string;
}

/** RTL breadcrumb trail; the last item is the current page (not a link). */
export function Breadcrumbs({ items }: { readonly items: readonly BreadcrumbItem[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <nav aria-label="مسیر صفحه" className="mb-2">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
        <li>
          <Link to="/" className="inline-flex items-center gap-1 hover:text-brand-700" aria-label="داشبورد">
            <Home aria-hidden className="size-3.5" />
          </Link>
        </li>
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex items-center gap-1">
            <ChevronLeft aria-hidden className="size-3.5 opacity-60" />
            {item.to === undefined || index === items.length - 1 ? (
              <span aria-current={index === items.length - 1 ? 'page' : undefined} className="text-slate-700 dark:text-slate-200">
                {item.label}
              </span>
            ) : (
              <Link to={item.to} className="hover:text-brand-700">
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly breadcrumbs?: readonly BreadcrumbItem[];
}

/** Standard screen header with title, help text and primary actions. */
export function PageHeader({ title, description, actions, breadcrumbs }: PageHeaderProps) {
  return (
    <header className="mb-4">
      {breadcrumbs !== undefined && <Breadcrumbs items={breadcrumbs} />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{title}</h1>
          {description !== undefined && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>
          )}
        </div>
        {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
