import { useId, type ReactNode } from 'react';
import { clsx } from 'clsx';

export interface TooltipProps {
  readonly content: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * Lightweight tooltip shown on hover/focus. The trigger wrapper is focusable so
 * keyboard users can read the hint (supplemental text, never the only label).
 */
export function Tooltip({ content, children, className }: TooltipProps) {
  const id = useId();
  return (
    <span className={clsx('group relative inline-flex', className)}>
      <span aria-describedby={id} className="inline-flex">
        {children}
      </span>
      <span
        role="tooltip"
        id={id}
        className="pointer-events-none absolute bottom-full start-1/2 z-40 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow-md group-hover:block group-focus-within:block"
      >
        {content}
      </span>
    </span>
  );
}
