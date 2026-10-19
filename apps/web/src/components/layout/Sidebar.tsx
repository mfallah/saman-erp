import { clsx } from 'clsx';
import { Link, useRouterState } from '@tanstack/react-router';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useAuth } from '../../lib/use-auth';
import { hasPermission } from '../../lib/auth-store';
import { NAV_ITEMS, type NavChild, type NavItem } from './nav';
import { IconButton } from '../ui/IconButton';

interface SidebarProps {
  readonly collapsed: boolean;
  readonly onToggleCollapse: () => void;
  readonly onNavigate?: () => void;
  readonly className?: string;
}

function visibleChildren(item: NavItem): readonly NavChild[] {
  return (item.children ?? []).filter(
    (child) => child.permission === undefined || hasPermission(child.permission),
  );
}

function isVisible(item: NavItem): boolean {
  if (item.permission !== undefined && !hasPermission(item.permission)) {
    return false;
  }
  if (item.children !== undefined && visibleChildren(item).length === 0) {
    return false;
  }
  return true;
}

/** Permission-aware RTL sidebar used by the desktop shell and mobile drawer. */
export function Sidebar({ collapsed, onToggleCollapse, onNavigate, className }: SidebarProps) {
  // Re-render whenever auth/permissions change.
  useAuth();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const items = NAV_ITEMS.filter(isVisible);

  const isActive = (target: string | undefined, item: NavItem): boolean => {
    if (target === undefined) {
      return false;
    }
    if (target === '/') {
      return pathname === '/';
    }
    if (pathname === target || pathname.startsWith(`${target}/`)) {
      return true;
    }
    return (item.children ?? []).some(
      (child) => pathname === child.to || pathname.startsWith(`${child.to}/`),
    );
  };

  return (
    <aside
      className={clsx(
        'flex h-dvh flex-col border-e border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900',
        className,
      )}
      aria-label="منوی اصلی"
    >
      <div className="flex h-14 items-center justify-between gap-2 border-b border-slate-200 px-3 dark:border-slate-700">
        {!collapsed && (
          <Link to="/" className="flex items-center gap-2" onClick={onNavigate} aria-label="سامان ERP — داشبورد">
            <span className="grid size-8 place-items-center rounded-lg bg-brand-700 text-sm font-bold text-white">
              س
            </span>
            <span className="text-sm font-bold text-slate-900 dark:text-slate-100">سامان ERP</span>
          </Link>
        )}
        {collapsed && (
          <span className="mx-auto grid size-8 place-items-center rounded-lg bg-brand-700 text-sm font-bold text-white" aria-hidden>
            س
          </span>
        )}
        <IconButton
          label={collapsed ? 'باز کردن منو' : 'جمع کردن منو'}
          icon={collapsed ? <ChevronsLeft className="size-4" /> : <ChevronsRight className="size-4" />}
          size="sm"
          onClick={onToggleCollapse}
          className="hidden lg:inline-flex"
        />
      </div>

      <nav className="flex-1 overflow-y-auto p-2" aria-label="ناوبری اصلی">
        <ul className="space-y-0.5">
          {items.map((item) => {
            const children = visibleChildren(item);
            const active = isActive(item.to, item);
            const Icon = item.icon;
            const firstChild = children[0];
            const target = item.to ?? firstChild?.to;
            if (target === undefined) {
              return null;
            }
            return (
              <li key={item.key}>
                <Link
                  to={target}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  title={collapsed ? item.label : undefined}
                  className={clsx(
                    'flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                    active
                      ? 'bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-200'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                    collapsed && 'justify-center px-0',
                  )}
                >
                  <Icon aria-hidden className="size-5 shrink-0" />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
                {!collapsed && children.length > 0 && (
                  <ul className="mb-1 mt-0.5 space-y-0.5 ps-7">
                    {children.map((child) => {
                      const childActive =
                        pathname === child.to || pathname.startsWith(`${child.to}/`);
                      return (
                        <li key={child.to}>
                          <Link
                            to={child.to}
                            onClick={onNavigate}
                            aria-current={childActive ? 'page' : undefined}
                            className={clsx(
                              'block rounded-md px-2 py-1.5 text-xs transition-colors',
                              childActive
                                ? 'bg-slate-100 font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
                            )}
                          >
                            {child.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {!collapsed && (
        <div className="border-t border-slate-200 p-3 text-[11px] text-slate-400 dark:border-slate-700 dark:text-slate-500">
          سامان ERP · نسخه ۱٫۰
        </div>
      )}
    </aside>
  );
}
