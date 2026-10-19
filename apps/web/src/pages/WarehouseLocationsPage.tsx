import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, Layers } from 'lucide-react';
import { api } from '../lib/api-client';
import { useDocumentTitle } from '../lib/hooks';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { usePathParam } from '../lib/router';
import { useHasPermission } from '../lib/use-auth';
import type { LocationNode } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { PageHeader } from '../components/ui/PageHeader';
import { SkeletonText } from '../components/ui/Skeleton';

interface LocationTreeItemProps {
  readonly node: LocationNode;
  readonly depth: number;
  readonly expandedIds: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
}

function LocationTreeItem({ node, depth, expandedIds, onToggle }: LocationTreeItemProps) {
  const children = node.children ?? [];
  const hasChildren = children.length > 0;
  const expanded = expandedIds.has(node.id);
  return (
    <li>
      <div
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800"
        style={{ paddingInlineStart: `${depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            aria-expanded={expanded}
            aria-label={expanded ? `بستن ${node.code}` : `باز کردن ${node.code}`}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            {expanded ? <ChevronDown className="size-4" /> : <ChevronLeft className="size-4" />}
          </button>
        ) : (
          <span className="inline-block size-5" aria-hidden />
        )}
        <Layers aria-hidden className="size-4 text-slate-400" />
        <span dir="ltr" className="text-sm font-medium text-slate-800 dark:text-slate-100">
          {node.code}
        </span>
        <Badge tone="neutral">{node.type}</Badge>
        {node.barcode !== undefined && node.barcode !== null && (
          <span dir="ltr" className="text-[11px] text-slate-400">
            {node.barcode}
          </span>
        )}
        {node.status !== undefined && node.status !== 'active' && (
          <Badge tone="warning">{node.status}</Badge>
        )}
      </div>
      {hasChildren && expanded && (
        <ul>
          {children.map((child) => (
            <LocationTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Hierarchical location tree of one warehouse. */
export function WarehouseLocationsPage() {
  const id = usePathParam('id');
  useDocumentTitle('موقعیت‌های انبار');
  const canRead = useHasPermission(PERM.locationRead);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set<string>());

  const warehouseQuery = useQuery({
    queryKey: queryKeys.warehouses.details(id),
    queryFn: () => api.get<{ id: string; name: string; code: string }>(`/warehouses/${id}`),
    enabled: canRead,
  });
  const treeQuery = useQuery({
    queryKey: queryKeys.warehouses.tree(id),
    queryFn: () => api.get<readonly LocationNode[]>(`/warehouses/${id}/tree`),
    enabled: canRead,
  });

  const toggle = (nodeId: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  if (!canRead) {
    return (
      <>
        <PageHeader title="موقعیت‌های انبار" />
        <PermissionNotice permission={PERM.locationRead} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="موقعیت‌های انبار"
        description={warehouseQuery.data === undefined ? 'ساختار سلسله‌مراتبی موقعیت‌ها' : `${warehouseQuery.data.name} (${warehouseQuery.data.code})`}
        breadcrumbs={[
          { label: 'انبار', to: '/inventory' },
          { label: 'انبارها', to: '/warehouses' },
          { label: 'موقعیت‌ها' },
        ]}
      />

      {treeQuery.isLoading && <SkeletonText lines={6} />}
      {treeQuery.isError && <ErrorState error={treeQuery.error} onRetry={() => void treeQuery.refetch()} />}
      {treeQuery.data !== undefined && treeQuery.data.length === 0 && (
        <EmptyState
          icon={<Layers className="size-9" />}
          title="موقعیتی برای این انبار ثبت نشده است"
          description="ساختار موقعیت‌ها شامل زون، راهرو، قفسه و بین است و از بخش تنظیمات انبار ایجاد می‌شود."
        />
      )}
      {treeQuery.data !== undefined && treeQuery.data.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
          <p className="border-b border-slate-100 px-2 pb-2 text-xs text-slate-500 dark:border-slate-800">
            برای مشاهده زیرشاخه‌ها روی فلش هر موقعیت بزنید.
          </p>
          <ul className="py-1" role="tree" aria-label="درخت موقعیت‌های انبار">
            {treeQuery.data.map((node) => (
              <LocationTreeItem
                key={node.id}
                node={node}
                depth={0}
                expandedIds={expandedIds}
                onToggle={toggle}
              />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
