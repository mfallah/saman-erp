import { useId, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { FileUp, Loader2, X } from 'lucide-react';

export interface UploadedFileItem {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes?: number;
}

export interface FileDropzoneProps {
  readonly onFiles: (files: readonly File[]) => void;
  readonly accept?: string;
  readonly maxSizeMB?: number;
  readonly multiple?: boolean;
  readonly disabled?: boolean;
  readonly uploading?: boolean;
  readonly files?: readonly UploadedFileItem[];
  readonly onRemove?: (id: string) => void;
  readonly label?: string;
  readonly hint?: string;
  readonly onValidationError?: (message: string) => void;
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} بایت`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} کیلوبایت`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} مگابایت`;
}

/** Drag & drop file picker with client-side type/size validation. */
export function FileDropzone({
  onFiles,
  accept,
  maxSizeMB = 10,
  multiple = true,
  disabled = false,
  uploading = false,
  files = [],
  onRemove,
  label = 'بارگذاری فایل',
  hint,
  onValidationError,
}: FileDropzoneProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleFiles = (selected: FileList | null): void => {
    if (selected === null || selected.length === 0) {
      return;
    }
    const list = [...selected];
    const oversized = list.find((file) => file.size > maxSizeMB * 1024 * 1024);
    if (oversized !== undefined) {
      const message = `حجم فایل «${oversized.name}» بیش از ${maxSizeMB} مگابایت است.`;
      setError(message);
      onValidationError?.(message);
      return;
    }
    setError(undefined);
    onFiles(multiple ? list : list.slice(0, 1));
  };

  return (
    <div>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) {
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!disabled) {
            handleFiles(event.dataTransfer.files);
          }
        }}
        className={clsx(
          'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors',
          dragging
            ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/30'
            : 'border-slate-300 bg-slate-50/60 dark:border-slate-600 dark:bg-slate-900',
          (disabled || uploading) && 'opacity-60',
        )}
      >
        {uploading ? (
          <Loader2 aria-hidden className="size-6 animate-spin text-brand-700" />
        ) : (
          <FileUp aria-hidden className="size-6 text-slate-400" />
        )}
        <div>
          <button
            type="button"
            disabled={disabled || uploading}
            onClick={() => inputRef.current?.click()}
            className="text-sm font-medium text-brand-700 hover:underline disabled:cursor-not-allowed dark:text-brand-300"
          >
            {label}
          </button>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {hint ?? `فایل را اینجا رها کنید؛ حداکثر ${maxSizeMB} مگابایت.`}
          </p>
        </div>
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled || uploading}
          className="sr-only"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
      {error !== undefined && (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((file) => (
            <li
              key={file.id}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
            >
              <span className="truncate">{file.name}</span>
              <span className="flex items-center gap-2 text-slate-400">
                {formatSize(file.sizeBytes)}
                {onRemove !== undefined && (
                  <button
                    type="button"
                    aria-label={`حذف ${file.name}`}
                    onClick={() => onRemove(file.id)}
                    className="rounded p-0.5 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
