import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatNumber } from '../../lib/money';
import { Button } from './Button';

interface BaseProps {
  readonly disabled?: boolean;
}

export interface CursorPaginationProps extends BaseProps {
  readonly mode: 'cursor';
  readonly hasMore: boolean;
  readonly onNext: () => void;
  readonly onPrev: () => void;
  readonly canPrev: boolean;
}

export interface OffsetPaginationProps extends BaseProps {
  readonly mode: 'offset';
  readonly page: number;
  readonly perPage: number;
  readonly total?: number;
  readonly totalPages?: number;
  readonly onPageChange: (page: number) => void;
}

export type PaginationProps = CursorPaginationProps | OffsetPaginationProps;

/** Cursor and offset pagination for list screens. */
export function Pagination(props: PaginationProps) {
  if (props.mode === 'cursor') {
    return (
      <nav
        aria-label="صفحه‌بندی"
        className="flex items-center justify-between gap-2 pt-3 text-sm"
      >
        <Button
          variant="outline"
          size="sm"
          disabled={!props.canPrev || props.disabled === true}
          onClick={props.onPrev}
          icon={<ChevronRight aria-hidden className="size-4" />}
        >
          قبلی
        </Button>
        <span className="text-xs text-slate-500">صفحه‌بندی ترتیبی</span>
        <Button
          variant="outline"
          size="sm"
          disabled={!props.hasMore || props.disabled === true}
          onClick={props.onNext}
          iconEnd={<ChevronLeft aria-hidden className="size-4" />}
        >
          بعدی
        </Button>
      </nav>
    );
  }

  const totalPages = props.totalPages ?? (props.total === undefined ? undefined : Math.max(1, Math.ceil(props.total / props.perPage)));
  return (
    <nav aria-label="صفحه‌بندی" className="flex flex-wrap items-center justify-between gap-2 pt-3 text-sm">
      <div className="text-xs text-slate-500 dark:text-slate-400">
        {props.total === undefined
          ? `صفحه ${formatNumber(props.page)}`
          : `${formatNumber(props.total)} مورد · صفحه ${formatNumber(props.page)}${
              totalPages === undefined ? '' : ` از ${formatNumber(totalPages)}`
            }`}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={props.page <= 1 || props.disabled === true}
          onClick={() => props.onPageChange(props.page - 1)}
          icon={<ChevronRight aria-hidden className="size-4" />}
        >
          قبلی
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={
            props.disabled === true ||
            (totalPages !== undefined ? props.page >= totalPages : false)
          }
          onClick={() => props.onPageChange(props.page + 1)}
          iconEnd={<ChevronLeft aria-hidden className="size-4" />}
        >
          بعدی
        </Button>
      </div>
    </nav>
  );
}
