import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';

interface DialogBaseProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg' | 'xl';
  readonly closeOnOverlay?: boolean;
}

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
} as const;

function useDialogBehavior(open: boolean, onClose: () => void): {
  panelRef: React.RefObject<HTMLDivElement | null>;
  titleId: string;
} {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = panel?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusables?.[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || panel === null) {
        return;
      }
      const nodes = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (nodes.length === 0) {
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  return { panelRef, titleId };
}

function Overlay({
  onClose,
  closeOnOverlay,
  children,
}: {
  readonly onClose: () => void;
  readonly closeOnOverlay: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onMouseDown={(event) => {
        if (closeOnOverlay && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      {children}
    </div>
  );
}

/** Accessible modal dialog: focus trap, Escape, aria-modal, scroll lock. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeOnOverlay = true,
}: DialogBaseProps) {
  const { panelRef, titleId } = useDialogBehavior(open, onClose);
  if (!open) {
    return null;
  }
  return createPortal(
    <Overlay onClose={onClose} closeOnOverlay={closeOnOverlay}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={clsx(
          'flex max-h-[90vh] w-full flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-slate-900',
          SIZES[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-4 dark:border-slate-700">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {title}
            </h2>
            {description !== undefined && (
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>
            )}
          </div>
          <IconButton label="بستن" icon={<X className="size-5" />} onClick={onClose} />
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer !== undefined && (
          <div className="flex justify-end gap-2 border-t border-slate-200 p-4 dark:border-slate-700">
            {footer}
          </div>
        )}
      </div>
    </Overlay>,
    document.body,
  );
}

export interface DrawerProps extends DialogBaseProps {
  readonly side?: 'start' | 'end';
}

/** Side drawer used by the mobile sidebar. */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size: _size = 'sm',
  closeOnOverlay = true,
  side = 'start',
}: DrawerProps) {
  const { panelRef, titleId } = useDialogBehavior(open, onClose);
  if (!open) {
    return null;
  }
  return createPortal(
    <div className="fixed inset-0 z-50 bg-slate-900/50" onMouseDown={(event) => {
      if (closeOnOverlay && event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={clsx(
          'absolute top-0 flex h-full w-80 max-w-[85vw] flex-col overflow-hidden bg-white shadow-xl dark:bg-slate-900',
          side === 'start' ? 'start-0' : 'end-0',
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-4 dark:border-slate-700">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {title}
            </h2>
            {description !== undefined && (
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>
            )}
          </div>
          <IconButton label="بستن" icon={<X className="size-5" />} onClick={onClose} />
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer !== undefined && (
          <div className="border-t border-slate-200 p-4 dark:border-slate-700">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
