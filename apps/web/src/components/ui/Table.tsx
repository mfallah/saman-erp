import { useMemo, useState, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { Skeleton } from './Skeleton';

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly render?: (row: T) => ReactNode;
  readonly sortable?: boolean;
  readonly align?: 'start' | 'center' | 'end';
  readonly className?: string;
  readonly width?: string;
}

export interface DataTableProps<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly loading?: boolean;
  readonly error?: unknown;
  readonly onRetry?: () => void;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly emptyAction?: ReactNode;
  readonly onRowClick?: (row: T) => void;
  readonly stickyHeader?: boolean;
  readonly caption?: string;
  readonly footer?: ReactNode;
}

const ALIGN = { start: 'text-start', center: 'text-center', end: 'text-end' } as const;

/**
 * Data table built on TanStack Table: sortable headers, sticky header,
 * loading skeleton rows, Persian empty/error states and optional row links.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  error,
  onRetry,
  emptyTitle = 'داده‌ای برای نمایش وجود ندارد',
  emptyDescription,
  emptyAction,
  onRowClick,
  stickyHeader = true,
  caption,
  footer,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const columnDefs = useMemo<ColumnDef<T, unknown>[]>(
    () =>
      columns.map((column) => ({
        id: column.key,
        accessorFn: (row: T) => row,
        header: column.header,
        enableSorting: column.sortable === true,
        cell: ({ row }) =>
          column.render === undefined ? null : column.render(row.original),
        meta: { align: column.align, className: column.className, width: column.width },
      })),
    [columns],
  );

  const table = useReactTable({
    data: rows as T[],
    columns: columnDefs,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (error !== undefined && error !== null) {
    return <ErrorState message={undefined} error={error} onRetry={onRetry} />;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
      <table className="min-w-full border-collapse text-sm">
        {caption !== undefined && <caption className="sr-only">{caption}</caption>}
        <thead
          className={clsx(
            'bg-slate-50 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300',
            stickyHeader && 'sticky top-0 z-10',
          )}
        >
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const column = columns.find((candidate) => candidate.key === header.column.id);
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    scope="col"
                    style={column?.width === undefined ? undefined : { width: column.width }}
                    className={clsx(
                      'whitespace-nowrap border-b border-slate-200 px-3 py-2.5 font-medium dark:border-slate-700',
                      column?.align === 'end'
                        ? ALIGN.end
                        : column?.align === 'center'
                          ? ALIGN.center
                          : ALIGN.start,
                    )}
                  >
                    {column?.sortable === true ? (
                      <button
                        type="button"
                        onClick={() => header.column.toggleSorting()}
                        className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white"
                        aria-label={`مرتب‌سازی بر اساس ${column.header}`}
                      >
                        {column.header}
                        {sorted === 'asc' ? (
                          <ArrowUp aria-hidden className="size-3.5" />
                        ) : sorted === 'desc' ? (
                          <ArrowDown aria-hidden className="size-3.5" />
                        ) : (
                          <ArrowUpDown aria-hidden className="size-3.5 opacity-50" />
                        )}
                      </button>
                    ) : (
                      column?.header ?? flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: 5 }, (_, rowIndex) => (
              <tr key={`skeleton-${rowIndex}`} className="border-b border-slate-100 dark:border-slate-800">
                {columns.map((column) => (
                  <td key={column.key} className="px-3 py-3">
                    <Skeleton className="h-4 w-full max-w-40" />
                  </td>
                ))}
              </tr>
            ))}
          {!loading &&
            table.getRowModel().rows.map((row) => (
              <tr
                key={rowKey(row.original)}
                onClick={onRowClick === undefined ? undefined : () => onRowClick(row.original)}
                className={clsx(
                  'border-b border-slate-100 bg-white last:border-0 dark:border-slate-800 dark:bg-slate-900',
                  onRowClick !== undefined && 'cursor-pointer hover:bg-brand-50/60 dark:hover:bg-slate-800',
                )}
              >
                {row.getVisibleCells().map((cell, cellIndex) => {
                  const column = columns[cellIndex];
                  return (
                    <td
                      key={cell.id}
                      className={clsx(
                        'whitespace-nowrap px-3 py-2.5 text-slate-700 dark:text-slate-200',
                        column?.align === 'end'
                          ? ALIGN.end
                          : column?.align === 'center'
                            ? ALIGN.center
                            : ALIGN.start,
                        column?.className,
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))}
        </tbody>
        {footer !== undefined && (
          <tfoot className="bg-slate-50 font-medium dark:bg-slate-800">{footer}</tfoot>
        )}
      </table>
      {!loading && rows.length === 0 && (
        <EmptyState
          title={emptyTitle}
          {...(emptyDescription === undefined ? {} : { description: emptyDescription })}
          {...(emptyAction === undefined ? {} : { action: emptyAction })}
        />
      )}
    </div>
  );
}
