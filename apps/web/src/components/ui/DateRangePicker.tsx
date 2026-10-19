import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import {
  currentJalaliMonthEndISO,
  currentJalaliMonthStartISO,
  formatJalali,
  lastNDaysISO,
  parseJalaliInput,
  formatJalaliInput,
  type DateRangeISO,
} from '../../lib/dates';
import { Button } from './Button';
import { Input } from './Input';

export interface DateRangePickerProps {
  readonly value: DateRangeISO;
  readonly onChange: (range: DateRangeISO) => void;
  readonly label?: string;
  readonly presets?: boolean;
  readonly className?: string;
}

const PRESETS: readonly { readonly label: string; readonly range: () => DateRangeISO }[] = [
  { label: '۷ روز', range: () => lastNDaysISO(7) },
  { label: '۳۰ روز', range: () => lastNDaysISO(30) },
  { label: '۹۰ روز', range: () => lastNDaysISO(90) },
  {
    label: 'ماه جاری',
    range: () => ({ from: currentJalaliMonthStartISO(), to: currentJalaliMonthEndISO() }),
  },
];

/**
 * Jalali date-range picker. Text inputs accept `1405/04/27` and are converted to
 * Gregorian ISO dates (the API contract only accepts Gregorian ranges).
 */
export function DateRangePicker({
  value,
  onChange,
  label = 'بازه زمانی',
  presets = true,
  className,
}: DateRangePickerProps) {
  const [fromText, setFromText] = useState(() => formatJalaliInput(value.from));
  const [toText, setToText] = useState(() => formatJalaliInput(value.to));
  const [error, setError] = useState<string | undefined>(undefined);

  const commit = (nextFrom: string, nextTo: string): void => {
    try {
      const from = parseJalaliInput(nextFrom);
      const to = parseJalaliInput(nextTo);
      if (from > to) {
        setError('تاریخ شروع باید قبل از تاریخ پایان باشد.');
        return;
      }
      setError(undefined);
      onChange({ from, to });
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'تاریخ معتبر نیست.');
    }
  };

  return (
    <div className={className}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{label}</span>
        <span className="text-[11px] text-slate-400" aria-hidden>
          {formatJalali(value.from)} تا {formatJalali(value.to)}
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-36">
          <label htmlFor="date-range-from" className="mb-1 block text-[11px] text-slate-500">
            از تاریخ
          </label>
          <Input
            id="date-range-from"
            value={fromText}
            dir="ltr"
            onChange={(event) => setFromText(event.target.value)}
            onBlur={() => commit(fromText, toText)}
            startIcon={<CalendarDays className="size-4" />}
            aria-label="تاریخ شروع (شمسی)"
            invalid={error !== undefined}
          />
        </div>
        <div className="w-36">
          <label htmlFor="date-range-to" className="mb-1 block text-[11px] text-slate-500">
            تا تاریخ
          </label>
          <Input
            id="date-range-to"
            value={toText}
            dir="ltr"
            onChange={(event) => setToText(event.target.value)}
            onBlur={() => commit(fromText, toText)}
            startIcon={<CalendarDays className="size-4" />}
            aria-label="تاریخ پایان (شمسی)"
            invalid={error !== undefined}
          />
        </div>
        {presets && (
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                variant="outline"
                size="sm"
                onClick={() => {
                  const range = preset.range();
                  setFromText(formatJalaliInput(range.from));
                  setToText(formatJalaliInput(range.to));
                  setError(undefined);
                  onChange(range);
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      {error !== undefined && (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
