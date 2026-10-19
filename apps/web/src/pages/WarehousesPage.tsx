import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { MapPin, Warehouse as WarehouseIcon } from 'lucide-react';
import { api } from '../lib/api-client';
import { useDocumentTitle } from '../lib/hooks';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { Warehouse } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { PageHeader } from '../components/ui/PageHeader';
import { SkeletonText } from '../components/ui/Skeleton';

/** Warehouse list; each card links to the hierarchical location tree. */
export function WarehousesPage() {
  useDocumentTitle('انبارها');
  const canRead = useHasPermission(PERM.warehouseRead);
  const canReadLocations = useHasPermission(PERM.locationRead);
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.warehouses.list,
    queryFn: () => api.get<readonly Warehouse[]>('/warehouses', { perPage: 100 }),
    enabled: canRead,
  });

  if (!canRead) {
    return (
      <>
        <PageHeader title="انبارها" />
        <PermissionNotice permission={PERM.warehouseRead} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="انبارها"
        description="انبارها و ساختار موقعیت‌های انبار"
        breadcrumbs={[{ label: 'انبار', to: '/inventory' }, { label: 'انبارها' }]}
      />

      {query.isLoading && <SkeletonText lines={4} />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}

      {query.data !== undefined && query.data.length === 0 && (
        <EmptyState
          icon={<WarehouseIcon className="size-9" />}
          title="انباری ثبت نشده است"
          description="انبارها از بخش تنظیمات سازمان ایجاد می‌شوند."
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(query.data ?? []).map((warehouse) => (
          <Card key={warehouse.id} className="flex flex-col justify-between">
            <div>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {warehouse.name}
                  </h2>
                  <p dir="ltr" className="mt-0.5 text-xs text-slate-500">
                    {warehouse.code}
                  </p>
                </div>
                <Badge tone="brand">
                  <WarehouseIcon aria-hidden className="size-3.5" />
                  {warehouse.type ?? 'انبار'}
                </Badge>
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                {warehouse.status !== undefined && <StatusBadge status={warehouse.status} />}
                <span>{warehouse.branch?.name ?? '—'}</span>
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              {canReadLocations ? (
                <Link
                  to="/warehouses/$id/locations"
                  params={{ id: warehouse.id }}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <MapPin aria-hidden className="size-4" />
                  موقعیت‌ها
                </Link>
              ) : (
                <span className="text-xs text-slate-400">دسترسی موقعیت‌ها محدود است</span>
              )}
              <button
                type="button"
                onClick={() => setExpanded((current) => (current === warehouse.id ? null : warehouse.id))}
                aria-expanded={expanded === warehouse.id}
                className="text-xs text-brand-700 hover:underline dark:text-brand-300"
              >
                {expanded === warehouse.id ? 'بستن خلاصه' : 'خلاصه وضعیت'}
              </button>
            </div>
            {expanded === warehouse.id && (
              <p className="mt-3 rounded-lg bg-slate-50 p-2 text-[11px] text-slate-500 dark:bg-slate-800">
                برای مشاهده موجودی این انبار به بخش «موجودی و گردش» بروید و انبار را فیلتر کنید.
              </p>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
