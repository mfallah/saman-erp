import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { onSessionExpired } from '../../lib/auth-store';
import { PREF_KEYS } from '../../lib/config';
import { usePreferenceState } from '../../lib/hooks';
import { Drawer } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/** App shell: fixed RTL sidebar + topbar + routed content, mobile drawer. */
export function AppShell({ children }: { readonly children: ReactNode }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [collapsedPref, setCollapsedPref] = usePreferenceState(PREF_KEYS.sidebarCollapsed, 'false');
  const [themePref, setThemePref] = usePreferenceState(PREF_KEYS.theme, 'light');
  const [mobileOpen, setMobileOpen] = useState(false);
  const collapsed = collapsedPref === 'true';
  const theme: 'light' | 'dark' = themePref === 'dark' ? 'dark' : 'light';

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    return onSessionExpired((reason) => {
      toast.warning('نشست شما پایان یافت', 'برای ادامه دوباره وارد شوید.');
      void navigate({ to: '/login', search: { redirect: undefined } });
      void reason;
    });
  }, [navigate, toast]);

  return (
    <div className="min-h-dvh bg-slate-50 dark:bg-slate-950">
      <a
        href="#main-content"
        className="sr-only rounded-md bg-brand-700 px-3 py-2 text-sm text-white focus:not-sr-only focus:fixed focus:start-2 focus:top-2 focus:z-50"
      >
        پرش به محتوای اصلی
      </a>

      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsedPref(collapsed ? 'false' : 'true')}
        className="fixed inset-y-0 start-0 hidden lg:flex"
      />

      <Drawer open={mobileOpen} onClose={() => setMobileOpen(false)} title="منوی سامانه">
        <Sidebar
          collapsed={false}
          onToggleCollapse={() => setMobileOpen(false)}
          onNavigate={() => setMobileOpen(false)}
          className="h-full border-e-0"
        />
      </Drawer>

      <div className={collapsed ? 'lg:ps-16' : 'lg:ps-64'}>
        <Topbar
          onOpenMobileMenu={() => setMobileOpen(true)}
          theme={theme}
          onToggleTheme={() => setThemePref(theme === 'dark' ? 'light' : 'dark')}
        />
        <main id="main-content" className="mx-auto w-full max-w-7xl p-4 lg:p-6" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
