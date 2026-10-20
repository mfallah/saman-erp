import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, UserCheck, UserX } from 'lucide-react';
import { api, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { relativeTimeFa } from '../lib/dates';
import { useDebouncedValue, useDocumentTitle } from '../lib/hooks';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { Role, UserSummary } from '../types/api';
import { Can, PermissionNotice } from '../components/auth/Can';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Checkbox } from '../components/ui/Checkbox';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DataTableToolbar } from '../components/ui/DataTableToolbar';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { Switch } from '../components/ui/Switch';
import { DataTable, type Column } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';

const STATUS_OPTIONS = [
  { value: '', label: 'همه وضعیت‌ها' },
  { value: 'active', label: 'فعال' },
  { value: 'inactive', label: 'غیرفعال' },
];

export function UsersPage() {
  useDocumentTitle('کاربران');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasPermission(PERM.userRead);
  const canUpdate = useHasPermission(PERM.userUpdate);
  const canAssignRoles = useHasPermission(PERM.roleAssign);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 350);
  const [createOpen, setCreateOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [roleIds, setRoleIds] = useState<readonly string[]>([]);
  const [sendInvite, setSendInvite] = useState(true);
  const [deactivateTarget, setDeactivateTarget] = useState<UserSummary | null>(null);

  const usersQuery = useQuery({
    queryKey: queryKeys.identity.users({ q: debouncedSearch, status, page }),
    queryFn: () =>
      api.getPage<UserSummary>('/users', {
        page,
        perPage: 25,
        ...(debouncedSearch.length >= 2 ? { q: debouncedSearch } : {}),
        ...(status === '' ? {} : { 'filter[status]': status }),
      }),
    enabled: canRead,
  });

  const rolesQuery = useQuery({
    queryKey: queryKeys.identity.roles({ forPicker: true }),
    queryFn: () => api.getPage<Role>('/roles', { perPage: 100 }),
    enabled: canRead && (createOpen || canAssignRoles),
    staleTime: 5 * 60_000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<UserSummary>(
        '/users',
        {
          fullName: fullName.trim(),
          mobile: mobile.trim(),
          ...(email.trim() === '' ? {} : { email: email.trim() }),
          roleIds,
          branchIds: [],
          warehouseIds: [],
          sendInvite,
        },
        { idempotencyKey: newRequestId() },
      ),
    onSuccess: () => {
      toast.success('کاربر ایجاد شد', 'دسترسی‌ها بر اساس نقش‌های انتخاب‌شده اعمال می‌شود.');
      setCreateOpen(false);
      setFullName('');
      setMobile('');
      setEmail('');
      setRoleIds([]);
      invalidate();
    },
    onError: (error) => toast.error('ایجاد کاربر ناموفق بود', toFaErrorMessage(error)),
  });

  const activateMutation = useMutation({
    mutationFn: (userId: string) => api.post<UserSummary>(`/users/${userId}/activate`, {}),
    onSuccess: () => {
      toast.success('کاربر فعال شد');
      invalidate();
    },
    onError: (error) => toast.error('فعال‌سازی ناموفق بود', toFaErrorMessage(error)),
  });

  const deactivateMutation = useMutation({
    mutationFn: ({ userId, reason }: { userId: string; reason?: string }) =>
      api.post<UserSummary>(`/users/${userId}/deactivate`, { reason: reason ?? '' }),
    onSuccess: () => {
      toast.success('کاربر غیرفعال شد');
      setDeactivateTarget(null);
      invalidate();
    },
    onError: (error) => toast.error('غیرفعال‌سازی ناموفق بود', toFaErrorMessage(error)),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: (userId: string) =>
      api.post<{ delivery?: string; expiresIn?: number }>(`/users/${userId}/password/reset`, { delivery: 'sms' }),
    onSuccess: () => toast.success('بازنشانی رمز ارسال شد', 'پیامک/لینک بازنشانی برای کاربر ارسال می‌شود.'),
    onError: (error) => toast.error('بازنشانی رمز ناموفق بود', toFaErrorMessage(error)),
  });

  if (!canRead) {
    return (
      <>
        <PageHeader title="کاربران" />
        <PermissionNotice permission={PERM.userRead} />
      </>
    );
  }

  const columns: readonly Column<UserSummary>[] = [
    { key: 'fullName', header: 'نام', render: (user) => user.fullName },
    { key: 'mobile', header: 'موبایل', render: (user) => <span dir="ltr">{user.mobile ?? '—'}</span> },
    {
      key: 'roles',
      header: 'نقش‌ها',
      render: (user) =>
        (user.roles ?? []).length === 0 ? (
          '—'
        ) : (
          <span className="flex flex-wrap gap-1">
            {(user.roles ?? []).map((role) => (
              <Badge key={role.id} tone="brand">
                {role.nameFa ?? role.name}
              </Badge>
            ))}
          </span>
        ),
    },
    {
      key: 'status',
      header: 'وضعیت',
      render: (user) => <StatusBadge status={user.status ?? 'active'} />,
    },
    {
      key: 'actions',
      header: 'عملیات',
      render: (user) => (
        <span className="flex items-center gap-1">
          {canUpdate &&
            (user.status === 'inactive' ? (
              <Button
                size="sm"
                variant="outline"
                icon={<UserCheck className="size-3.5" />}
                loading={activateMutation.isPending}
                onClick={() => activateMutation.mutate(user.id)}
              >
                فعال‌سازی
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                icon={<UserX className="size-3.5" />}
                onClick={() => setDeactivateTarget(user)}
              >
                غیرفعال‌سازی
              </Button>
            ))}
          {canUpdate && (
            <Button
              size="sm"
              variant="ghost"
              icon={<KeyRound className="size-3.5" />}
              loading={resetPasswordMutation.isPending}
              onClick={() => resetPasswordMutation.mutate(user.id)}
            >
              بازنشانی رمز
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="کاربران"
        description="مدیریت کاربران، نقش‌ها و دسترسی‌ها"
        breadcrumbs={[{ label: 'تنظیمات' }, { label: 'کاربران' }]}
        actions={
          <Can permission={PERM.userCreate}>
            <Button icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
              کاربر جدید
            </Button>
          </Can>
        }
      />

      <DataTableToolbar
        searchValue={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="جستجوی نام، موبایل یا ایمیل…"
        filters={
          <Select
            aria-label="فیلتر وضعیت کاربر"
            options={STATUS_OPTIONS}
            value={status}
            className="w-36"
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          />
        }
        onRefresh={() => void usersQuery.refetch()}
        refreshing={usersQuery.isFetching}
      />

      <DataTable
        columns={columns}
        rows={usersQuery.data?.items ?? []}
        rowKey={(user) => user.id}
        loading={usersQuery.isLoading}
        error={usersQuery.isError ? usersQuery.error : undefined}
        onRetry={() => void usersQuery.refetch()}
        caption="فهرست کاربران"
        emptyTitle="کاربری یافت نشد"
        emptyDescription="با تغییر جستجو دوباره تلاش کنید یا کاربر جدید بسازید."
      />

      <Pagination
        mode="offset"
        page={page}
        perPage={25}
        {...(usersQuery.data?.pagination?.total === undefined
          ? {}
          : { total: usersQuery.data.pagination.total })}
        onPageChange={setPage}
        disabled={usersQuery.isFetching}
      />

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="ایجاد کاربر"
        description="نقش‌ها تعیین می‌کنند کاربر به چه بخش‌هایی دسترسی دارد."
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              انصراف
            </Button>
            <Button
              loading={createMutation.isPending}
              disabled={fullName.trim() === '' || !/^09\d{9}$/.test(mobile.trim())}
              onClick={() => createMutation.mutate()}
            >
              ایجاد کاربر
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField label="نام و نام خانوادگی" required>
            <Input value={fullName} onChange={(event) => setFullName(event.target.value)} />
          </FormField>
          <FormField label="شماره موبایل" required hint="۱۱ رقم و شروع با ۰۹">
            <Input
              dir="ltr"
              className="text-left"
              inputMode="numeric"
              placeholder="09121234567"
              value={mobile}
              onChange={(event) => setMobile(event.target.value)}
            />
          </FormField>
          <FormField label="ایمیل" hint="اختیاری">
            <Input
              dir="ltr"
              className="text-left"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </FormField>
          <FormField label="نقش‌ها">
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2 dark:border-slate-700">
              {(rolesQuery.data?.items ?? []).map((role) => (
                <Checkbox
                  key={role.id}
                  label={role.nameFa}
                  checked={roleIds.includes(role.id)}
                  onChange={(event) =>
                    setRoleIds((current) =>
                      event.target.checked ? [...current, role.id] : current.filter((id) => id !== role.id),
                    )
                  }
                />
              ))}
              {rolesQuery.data !== undefined && rolesQuery.data.items.length === 0 && (
                <p className="text-xs text-slate-500">نقشی برای انتخاب وجود ندارد.</p>
              )}
            </div>
          </FormField>
          <Switch
            label="ارسال پیامک دعوت"
            checked={sendInvite}
            onChange={(event) => setSendInvite(event.target.checked)}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={deactivateTarget !== null}
        title="غیرفعال‌سازی کاربر"
        description="با غیرفعال‌سازی، همه نشست‌های فعال کاربر بسته می‌شود."
        confirmLabel="غیرفعال کن"
        tone="danger"
        requireReason
        reasonLabel="دلیل غیرفعال‌سازی"
        loading={deactivateMutation.isPending}
        onConfirm={(reason) => {
          if (deactivateTarget !== null) {
            deactivateMutation.mutate({ userId: deactivateTarget.id, ...(reason === undefined ? {} : { reason }) });
          }
        }}
        onCancel={() => setDeactivateTarget(null)}
      />

      {usersQuery.data !== undefined && usersQuery.data.items.length > 0 && (
        <p className="mt-2 text-[11px] text-slate-400">
          آخرین ورود نمایش‌داده‌شده:{' '}
          {usersQuery.data.items[0]?.lastLoginAt === undefined || usersQuery.data.items[0]?.lastLoginAt === null
            ? '—'
            : relativeTimeFa(usersQuery.data.items[0].lastLoginAt)}
        </p>
      )}
    </>
  );
}
