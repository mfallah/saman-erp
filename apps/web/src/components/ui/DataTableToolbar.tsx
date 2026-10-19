import type { ReactNode } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { IconButton } from './IconButton';
import { Input } from './Input';

export interface DataTableToolbarProps {
  readonly searchValue: string;
  readonly onSearchChange: (value: string) => void;
  readonly searchPlaceholder?: string;
  readonly filters?: ReactNode;
  readonly actions?: ReactNode;
  readonly onRefresh?: () => void;
  readonly refreshing?: boolean;
}

/** Search + filters + actions bar above tables. */
export function DataTableToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'جستجو…',
  filters,
  actions,
  onRefresh,
  refreshing = false,
}: DataTableToolbarProps) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="min-w-48 flex-1">
        <Input
          type="search"
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          startIcon={<Search className="size-4" />}
        />
      </div>
      {filters !== undefined && <div className="flex flex-wrap items-center gap-2">{filters}</div>}
      <div className="flex items-center gap-2">
        {onRefresh !== undefined && (
          <IconButton
            label="بازخوانی"
            icon={<RefreshCw className={refreshing ? 'size-4 animate-spin' : 'size-4'} />}
            onClick={onRefresh}
          />
        )}
        {actions}
      </div>
    </div>
  );
}
