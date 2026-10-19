import { useEffect, useState } from 'react';

/** Debounces a rapidly changing value (search boxes). */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Reactive connectivity flag used to warn operators in scanner flows. */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  return online;
}

/** Sets the document title with the app suffix. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · سامان ERP`;
  }, [title]);
}

/** Small open/close state helper for modals and drawers. */
export function useDisclosure(initialOpen = false): {
  open: boolean;
  show: () => void;
  hide: () => void;
  toggle: () => void;
} {
  const [open, setOpen] = useState(initialOpen);
  return {
    open,
    show: () => setOpen(true),
    hide: () => setOpen(false),
    toggle: () => setOpen((current) => !current),
  };
}

/** Stable localStorage-backed preference state (never used for tokens). */
export function usePreferenceState(
  key: string,
  fallback: string,
): [string, (next: string) => void] {
  const [value, setValue] = useState<string>(() => {
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const update = (next: string): void => {
    setValue(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // Storage can be unavailable (private mode); preference is non-critical.
    }
  };
  return [value, update];
}
