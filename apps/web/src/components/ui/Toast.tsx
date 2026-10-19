import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  readonly id: number;
  readonly tone: ToastTone;
  readonly title: string;
  readonly message?: string;
}

export interface ToastContextValue {
  readonly success: (title: string, message?: string) => void;
  readonly error: (title: string, message?: string) => void;
  readonly info: (title: string, message?: string) => void;
  readonly warning: (title: string, message?: string) => void;
  readonly dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_STYLES: Record<ToastTone, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100',
  error: 'border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100',
  warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
  info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100',
};

const ICONS: Record<ToastTone, ReactNode> = {
  success: <CheckCircle2 aria-hidden className="size-5" />,
  error: <AlertTriangle aria-hidden className="size-5" />,
  warning: <AlertTriangle aria-hidden className="size-5" />,
  info: <Info aria-hidden className="size-5" />,
};

/** Provides toast notifications; renders an aria-live region above the app. */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, title: string, message?: string) => {
      counter.current += 1;
      const id = counter.current;
      setToasts((current) => [...current, { id, tone, title, message }]);
      const timeout = tone === 'error' ? 8_000 : 5_000;
      window.setTimeout(() => dismiss(id), timeout);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      success: (title, message) => push('success', title, message),
      error: (title, message) => push('error', title, message),
      info: (title, message) => push('info', title, message),
      warning: (title, message) => push('warning', title, message),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          aria-atomic="false"
          className="pointer-events-none fixed bottom-4 start-4 z-[60] flex w-full max-w-sm flex-col gap-2"
        >
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role={toast.tone === 'error' ? 'alert' : 'status'}
              className={clsx(
                'pointer-events-auto flex items-start gap-2 rounded-xl border p-3 shadow-lg',
                TONE_STYLES[toast.tone],
              )}
            >
              {ICONS[toast.tone]}
              <div className="flex-1 text-sm">
                <p className="font-medium">{toast.title}</p>
                {toast.message !== undefined && <p className="mt-0.5 text-xs opacity-80">{toast.message}</p>}
              </div>
              <button
                type="button"
                aria-label="بستن اعلان"
                onClick={() => dismiss(toast.id)}
                className="rounded p-0.5 hover:bg-black/5"
              >
                <X aria-hidden className="size-4" />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/** Access the toast API; must be used inside `ToastProvider`. */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return context;
}
