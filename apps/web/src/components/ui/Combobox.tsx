import { useEffect, useId, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Check, ChevronDown, Loader2, Search } from 'lucide-react';

export interface ComboboxOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
}

export interface ComboboxProps {
  readonly id?: string;
  readonly value?: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly ComboboxOption[];
  readonly placeholder?: string;
  readonly invalid?: boolean;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly emptyMessage?: string;
  readonly ariaLabel?: string;
}

/**
 * Searchable select for long lists (categories, accounts, variants).
 * Implements the WAI-ARIA combobox pattern with Arrow/Enter/Escape keyboard
 * support; the listbox is rendered inline (no portal) to keep focus simple.
 */
export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder = 'انتخاب کنید',
  invalid = false,
  disabled = false,
  loading = false,
  emptyMessage = 'موردی یافت نشد.',
  ariaLabel,
}: ComboboxProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selected = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered =
    normalizedQuery === ''
      ? options
      : options.filter(
          (option) =>
            option.label.toLowerCase().includes(normalizedQuery) ||
            (option.hint ?? '').toLowerCase().includes(normalizedQuery),
        );

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent): void => {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [normalizedQuery, open]);

  const selectOption = (option: ComboboxOption): void => {
    if (option.disabled === true) {
      return;
    }
    onChange(option.value);
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        disabled={disabled || loading}
        onClick={() => {
          setOpen((current) => !current);
          window.setTimeout(() => inputRef.current?.focus(), 0);
        }}
        className={clsx(
          'flex h-10 w-full items-center justify-between gap-2 rounded-lg border bg-white px-3 text-sm shadow-sm',
          'focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20',
          'disabled:cursor-not-allowed disabled:bg-slate-50 dark:bg-slate-900 dark:text-slate-100',
          invalid ? 'border-red-500' : 'border-slate-300 dark:border-slate-600',
        )}
      >
        <span className={clsx('truncate', selected === undefined && 'text-slate-400')}>
          {selected?.label ?? placeholder}
        </span>
        {loading ? (
          <Loader2 aria-hidden className="size-4 animate-spin text-slate-400" />
        ) : (
          <ChevronDown aria-hidden className="size-4 text-slate-400" />
        )}
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <div className="relative border-b border-slate-100 p-2 dark:border-slate-800">
            <Search
              aria-hidden
              className="pointer-events-none absolute start-4 top-1/2 size-4 -translate-y-1/2 text-slate-400"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveIndex((current) => Math.min(current + 1, filtered.length - 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveIndex((current) => Math.max(current - 1, 0));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const option = filtered[activeIndex];
                  if (option !== undefined) {
                    selectOption(option);
                  }
                } else if (event.key === 'Escape') {
                  setOpen(false);
                  setQuery('');
                }
              }}
              placeholder="جستجو…"
              aria-label="جستجوی گزینه‌ها"
              className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 ps-9 pe-3 text-sm focus:border-brand-600 focus:outline-none dark:border-slate-700 dark:bg-slate-800"
            />
          </div>
          <ul id={listboxId} role="listbox" className="max-h-64 overflow-auto p-1">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-slate-500">{emptyMessage}</li>
            )}
            {filtered.map((option, index) => (
              <li
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(option)}
                className={clsx(
                  'flex cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-2 text-sm',
                  index === activeIndex && 'bg-brand-50 dark:bg-slate-800',
                  option.disabled === true && 'cursor-not-allowed opacity-50',
                )}
              >
                <span className="truncate">
                  {option.label}
                  {option.hint !== undefined && (
                    <span className="ms-2 text-xs text-slate-400">{option.hint}</span>
                  )}
                </span>
                {option.value === value && <Check aria-hidden className="size-4 text-brand-700" />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
