import { useRef, useState } from 'react';
import { ScanBarcode } from 'lucide-react';
import { Input } from './Input';

export interface BarcodeInputProps {
  readonly onScan: (code: string) => void;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly hint?: string;
  readonly clearOnScan?: boolean;
  readonly invalid?: boolean;
}

/**
 * Keyboard-wedge barcode input: hardware scanners type the code and send Enter.
 * Autofocus is on by default and focus is restored after each scan, so an
 * operator can scan continuously without touching the screen.
 */
export function BarcodeInput({
  onScan,
  placeholder = 'بارکد یا کد را اسکن کنید…',
  autoFocus = true,
  disabled = false,
  label = 'اسکن بارکد',
  hint,
  clearOnScan = true,
  invalid = false,
}: BarcodeInputProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const submit = (): void => {
    const code = value.trim();
    if (code.length === 0) {
      return;
    }
    onScan(code);
    if (clearOnScan) {
      setValue('');
    }
    inputRef.current?.focus();
  };

  return (
    <div>
      <label htmlFor="barcode-scan-input" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
        {label}
      </label>
      <Input
        id="barcode-scan-input"
        ref={inputRef}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        invalid={invalid}
        inputMode="none"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        aria-describedby={hint === undefined ? undefined : 'barcode-scan-hint'}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
        startIcon={<ScanBarcode className="size-5" />}
        className="h-12 text-base"
      />
      {hint !== undefined && (
        <p id="barcode-scan-hint" className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      )}
    </div>
  );
}
