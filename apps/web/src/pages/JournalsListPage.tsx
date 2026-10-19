import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BookOpen, Plus } from 'lucide-react';
import { api } from '../lib/api-client';
import { formatJalali } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { formatMoney } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { JournalEntrySummary } from '../types/api';
import { Can, PermissionNotice } from '../components/auth/Can';
import { StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { DataTableToolbar } from '../components/ui/DataTableToolbar';
import { EmptyState } from '../components/ui/EmptyState';
import { PageHeader } from '../components/ui/PageHeader';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { DataTable, type Column } from '../components/ui/Table';

const STATUS_OPTIONS = [
  { value: '', label: 'همه وضعیت‌ها' },
  { value: 'draft', label: 'پیش‌نویس' },
  { value: 'submitted', label: 'ارسال‌شده' },
  { value: 'approved', label: 'تأییدشده' },
  { value: 'posted', label: 'ثبت‌شده' },
];

const columns: readonly Column<JournalEntrySummary>[] = [
  {
    key: 'number',
    header: 'شماره سند',
    render: (journal) => (
      <span dir="ltr" className="font-medium">
        {journal.number ?? '—'}
      </span>
    ),
  },
  {
    key: 'date',
    header: 'تاریخ',
    render: (journal) => (journal.date === undefined ? '—' : formatJalali(journal.date)),
  },
  { key: 'description', header: 'شرح', render: (journal) => journal.description ?? '—' },
  { key: 'status', header: 'وضعیت', render: (journal) => <StatusBadge status={journal.status} /> },
  {
    key: 'total',
    header: 'مبلغ',
    align: 'end',
    render: (journal) => <span className="tabular">{journal.total === undefined ? '—' : formatMoney(journal.total)}</span>,
  },
  {
    key: 'createdAt',
    header: 'ثبت سیستم',
    render: (journal) => (journal.createdAt === undefined ? '—' : formatJalali(journal.createdAt)),
  },
];

/** Accounting journal list. */
export function JournalsListPage() {
  useDocumentTitle('دفتر روزنامه');
  const canRead = useHasPermission(PERM.journalRead);
  const canCreate = useHasPermission(PERM.journalCreate);
  const [status, setStatus] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<readonly (string | undefined)[]>([]);

  const query = useQuery({
    queryKey: queryKeys.accounting.journals({ status, cursor }),
    queryFn: () =>
      api.getPage<JournalEntrySummary>('/accounting/journal-entries', {
        limit: 25,
        ...(status === '' ? {} : { 'filter[status]': status }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    enabled: canRead,
  });

  if (!canRead) {
    return (
      <>
        <PageHeader title="دفتر روزنامه" />
        <PermissionNotice permission={PERM.journalRead} />
      </>
    );
  }

  const pagination = query.data?.pagination;
  const hasMore = pagination?.nextCursor !== undefined && pagination?.nextCursor !== null;

  return (
    <>
      <PageHeader
        title="دفتر روزنامه"
        description="اسناد حسابداری، وضعیت تأیید و ثبت"
        breadcrumbs={[{ label: 'مالی' }, { label: 'دفتر روزنامه' }]}
        actions={
          <Can permission={PERM.journalCreate}>
            <Link to="/accounting/journals/new">
              <Button icon={<Plus className="size-4" />}>سند جدید</Button>
            </Link>
          </Can>
        }
      />

      {!canCreate && (
        <p className="mb-3 text-xs text-slate-500">ثبت سند دستی نیازمند دسترسی accounting.journal.create است.</p>
      )}

      <DataTableToolbar
        searchValue=""
        onSearchChange={() => undefined}
        searchPlaceholder="جستجو در اسناد (به‌زودی)"
        filters={
          <Select
            aria-label="فیلتر وضعیت سند"
            options={STATUS_OPTIONS}
            value={status}
            className="w-40"
            onChange={(event) => {
              setStatus(event.target.value);
              setCursor(undefined);
              setHistory([]);
            }}
          />
        }
        onRefresh={() => void query.refetch()}
        refreshing={query.isFetching}
      />

      <DataTable
        columns={columns}
        rows={query.data?.items ?? []}
        rowKey={(journal) => journal.id}
        loading={query.isLoading}
        error={query.isError ? query.error : undefined}
        onRetry={() => void query.refetch()}
        caption="فهرست اسناد حسابداری"
        emptyTitle="سندی ثبت نشده است"
        emptyDescription="اسناد دستی و اسناد خودکار ناشی از رویدادهای فروش/خرید در این فهرست نمایش داده می‌شوند."
        emptyAction={
          <EmptyState
            icon={<BookOpen className="size-8" />}
            title="دفتر روزنامه خالی است"
            description="برای شروع، یک سند دستی جدید ثبت کنید."
          />
        }
      />

      <Pagination
        mode="cursor"
        hasMore={hasMore}
        canPrev={history.length > 0}
        disabled={query.isFetching}
        onNext={() => {
          const nextCursor = pagination?.nextCursor;
          if (nextCursor !== undefined && nextCursor !== null) {
            setHistory((current) => [...current, cursor]);
            setCursor(nextCursor);
          }
        }}
        onPrev={() => {
          const previous = history[history.length - 1];
          setHistory((current) => current.slice(0, -1));
          setCursor(previous);
        }}
      />
    </>
  );
}
