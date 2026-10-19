import { useEffect, useRef, useState, type RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Bell,
  ChevronDown,
  LogOut,
  Menu,
  Moon,
  Settings,
  Sun,
  UserCircle2,
  WifiOff,
} from 'lucide-react';
import { api } from '../../lib/api-client';
import { logout } from '../../lib/auth-store';
import { relativeTimeFa } from '../../lib/dates';
import { useOnlineStatus } from '../../lib/hooks';
import { PERM } from '../../lib/permissions';
import { queryKeys } from '../../lib/query-keys';
import { useAuth, useHasPermission } from '../../lib/use-auth';
import type { NotificationItem } from '../../types/api';
import { IconButton } from '../ui/IconButton';
import { useToast } from '../ui/Toast';

export interface TopbarProps {
  readonly onOpenMobileMenu: () => void;
  readonly theme: 'light' | 'dark';
  readonly onToggleTheme: () => void;
}

function useClickOutside(onOutside: () => void): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handler = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) {
        onOutside();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onOutside]);
  return ref;
}

/** Top application bar: mobile menu, notifications, theme, account menu. */
export function Topbar({ onOpenMobileMenu, theme, onToggleTheme }: TopbarProps) {
  const auth = useAuth();
  const online = useOnlineStatus();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const canReadNotifications = useHasPermission(PERM.notificationRead) || auth.status === 'authenticated';

  const notificationsQuery = useQuery({
    queryKey: queryKeys.notifications.inbox,
    queryFn: () => api.getPage<NotificationItem>('/notifications', { limit: 5 }),
    enabled: auth.status === 'authenticated' && canReadNotifications,
    staleTime: 60_000,
  });

  const notifications = notificationsQuery.data?.items ?? [];
  const unread = notifications.filter((item) => item.read !== true).length;

  const notificationsRef = useClickOutside(() => setNotificationsOpen(false));
  const accountRef = useClickOutside(() => setAccountOpen(false));

  const handleLogout = async (): Promise<void> => {
    await logout();
    queryClient.clear();
    toast.info('از حساب خارج شدید', 'برای ادامه دوباره وارد شوید.');
    await navigate({ to: '/login', search: { redirect: undefined } });
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b border-slate-200 bg-white/95 px-3 backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
      <div className="flex min-w-0 items-center gap-2">
        <IconButton
          label="باز کردن منو"
          icon={<Menu className="size-5" />}
          onClick={onOpenMobileMenu}
          className="lg:hidden"
        />
        {!online && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <WifiOff aria-hidden className="size-3.5" />
            اتصال شبکه قطع است
          </span>
        )}
      </div>

      <div className="flex items-center gap-1">
        <div className="relative" ref={notificationsRef}>
          <IconButton
            label="اعلان‌ها"
            icon={
              <span className="relative">
                <Bell className="size-5" />
                {unread > 0 && (
                  <span className="absolute -end-1 -top-1 grid min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
                    {unread.toLocaleString('fa-IR')}
                  </span>
                )}
              </span>
            }
            onClick={() => setNotificationsOpen((current) => !current)}
            aria-expanded={notificationsOpen}
          />
          {notificationsOpen && (
            <div className="absolute end-0 mt-1 w-72 rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
              <p className="px-2 py-1 text-xs font-medium text-slate-500">اعلان‌های اخیر</p>
              {notificationsQuery.isLoading && (
                <p className="px-2 py-3 text-xs text-slate-500">در حال دریافت…</p>
              )}
              {!notificationsQuery.isLoading && notifications.length === 0 && (
                <p className="px-2 py-3 text-xs text-slate-500">
                  {notificationsQuery.isError ? 'دریافت اعلان‌ها ناموفق بود.' : 'اعلانی ندارید.'}
                </p>
              )}
              <ul className="max-h-72 overflow-auto">
                {notifications.map((item) => (
                  <li key={item.id} className="rounded-md px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800">
                    <p className="text-xs font-medium text-slate-800 dark:text-slate-100">
                      {item.titleFa ?? 'اعلان سامانه'}
                    </p>
                    {item.bodyFa !== undefined && (
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{item.bodyFa}</p>
                    )}
                    {item.createdAt !== undefined && (
                      <p className="mt-0.5 text-[10px] text-slate-400">{relativeTimeFa(item.createdAt)}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <IconButton
          label={theme === 'dark' ? 'حالت روشن' : 'حالت تیره'}
          icon={theme === 'dark' ? <Sun className="size-5" /> : <Moon className="size-5" />}
          onClick={onToggleTheme}
        />

        <div className="relative" ref={accountRef}>
          <button
            type="button"
            onClick={() => setAccountOpen((current) => !current)}
            aria-expanded={accountOpen}
            aria-haspopup="menu"
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <UserCircle2 aria-hidden className="size-6 text-slate-500" />
            <span className="hidden max-w-32 truncate text-slate-700 sm:block dark:text-slate-200">
              {auth.user?.fullName ?? 'کاربر'}
            </span>
            <ChevronDown aria-hidden className="size-3.5 text-slate-400" />
          </button>
          {accountOpen && (
            <div
              role="menu"
              className="absolute end-0 mt-1 w-60 rounded-xl border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
            >
              <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-800">
                <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {auth.user?.fullName ?? 'کاربر'}
                </p>
                <p dir="ltr" className="mt-0.5 text-xs text-slate-500">
                  {auth.user?.mobile ?? ''}
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {(auth.user?.roles ?? []).map((role) => role.nameFa ?? role.name).join(' · ') || 'بدون نقش'}
                </p>
              </div>
              <Link
                to="/settings"
                role="menuitem"
                onClick={() => setAccountOpen(false)}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <Settings aria-hidden className="size-4" />
                تنظیمات حساب
              </Link>
              <button
                type="button"
                role="menuitem"
                onClick={() => void handleLogout()}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
              >
                <LogOut aria-hidden className="size-4" />
                خروج از حساب
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
