import { useRef, type ReactNode } from 'react';
import { clsx } from 'clsx';

export interface TabItem {
  readonly value: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly badge?: ReactNode;
  readonly disabled?: boolean;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly ariaLabel: string;
  readonly className?: string;
}

/** WAI-ARIA tabs with arrow-key navigation. */
export function Tabs({ items, value, onChange, ariaLabel, className }: TabsProps) {
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const focusTab = (index: number): void => {
    const target = items[index];
    if (target === undefined || target.disabled === true) {
      return;
    }
    onChange(target.value);
    buttonsRef.current[index]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={clsx(
        'flex gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1 dark:bg-slate-800',
        className,
      )}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(element) => {
              buttonsRef.current[index] = element;
            }}
            role="tab"
            type="button"
            id={`tab-${item.value}`}
            aria-selected={selected}
            aria-controls={`panel-${item.value}`}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled !== true) {
                onChange(item.value);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                focusTab(index + 1 >= items.length ? 0 : index + 1);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                focusTab(index === 0 ? items.length - 1 : index - 1);
              }
            }}
            className={clsx(
              'inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              selected
                ? 'bg-white text-brand-800 shadow-sm dark:bg-slate-900 dark:text-brand-200'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white',
              item.disabled === true && 'cursor-not-allowed opacity-50',
            )}
          >
            {item.icon}
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}

/** Renders the panel associated with the selected tab. */
export function TabPanel({
  value,
  children,
}: {
  readonly value: string;
  readonly children: ReactNode;
}) {
  return (
    <div role="tabpanel" id={`panel-${value}`} aria-labelledby={`tab-${value}`} className="pt-4">
      {children}
    </div>
  );
}
