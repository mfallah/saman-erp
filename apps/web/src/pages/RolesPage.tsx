import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save, ShieldCheck } from 'lucide-react';
import { api, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { useDocumentTitle } from '../lib/hooks';
import { formatNumber } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { PermissionRegistry, Role } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { Checkbox } from '../components/ui/Checkbox';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { SkeletonText } from '../components/ui/Skeleton';
import { Textarea } from '../components/ui/Textarea';
import { useToast } from '../components/ui/Toast';

/** Roles & permission matrix: system roles are read-only (API enforces it too). */
export function RolesPage() {
  useDocumentTitle('نقش‌ها و دسترسی‌ها');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasPermission(PERM.roleRead);
  const canAssign = useHasPermission(PERM.roleAssign);
  const canCreate = useHasPermission(PERM.roleCreate);
  const canReadPermissions = useHasPermission(PERM.permissionRead);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newNameFa, setNewNameFa] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const rolesQuery = useQuery({
    queryKey: queryKeys.identity.roles(),
    queryFn: () => api.getPage<Role>('/roles', { perPage: 100 }),
    enabled: canRead,
  });

  const roleDetailQuery = useQuery({
    queryKey: queryKeys.identity.role(selectedRoleId ?? ''),
    queryFn: () => api.get<Role>(`/roles/${selectedRoleId ?? ''}`),
    enabled: canRead && selectedRoleId !== null,
  });

  const registryQuery = useQuery({
    queryKey: queryKeys.identity.permissions,
    queryFn: () => api.get<PermissionRegistry>('/permissions'),
    enabled: canRead && canReadPermissions,
    staleTime: 10 * 60_000,
  });

  useEffect(() => {
    const role = roleDetailQuery.data;
    if (role?.permissions !== undefined) {
      setSelectedKeys(new Set(role.permissions));
    }
  }, [roleDetailQuery.data]);

  useEffect(() => {
    if (selectedRoleId === null) {
      const first = rolesQuery.data?.items[0];
      if (first !== undefined) {
        setSelectedRoleId(first.id);
      }
    }
  }, [rolesQuery.data, selectedRoleId]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const role = roleDetailQuery.data;
      if (role === undefined) {
        throw new Error('نقشی انتخاب نشده است.');
      }
      return api.put<{ keys: readonly string[]; affectedUsers?: number }>(
        `/roles/${role.id}/permissions`,
        { permissionKeys: [...selectedKeys] },
        { ...(role.version === undefined ? {} : { ifMatch: role.version }) },
      );
    },
    onSuccess: (result) => {
      toast.success(
        'دسترسی‌ها ذخیره شد',
        result.affectedUsers === undefined
          ? 'تغییرات برای کاربران این نقش اعمال شد.'
          : `${formatNumber(result.affectedUsers)} کاربر تحت تأثیر قرار گرفتند.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
    },
    onError: (error) => toast.error('ذخیره دسترسی‌ها ناموفق بود', toFaErrorMessage(error)),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<Role>(
        '/roles',
        {
          name: newName.trim(),
          nameFa: newNameFa.trim(),
          ...(newDescription.trim() === '' ? {} : { descriptionFa: newDescription.trim() }),
          permissionKeys: [],
        },
        { idempotencyKey: newRequestId() },
      ),
    onSuccess: (role) => {
      toast.success('نقش ایجاد شد');
      setCreateOpen(false);
      setNewName('');
      setNewNameFa('');
      setNewDescription('');
      setSelectedRoleId(role.id);
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
    },
    onError: (error) => toast.error('ایجاد نقش ناموفق بود', toFaErrorMessage(error)),
  });

  if (!canRead) {
    return (
      <>
        <PageHeader title="نقش‌ها و دسترسی‌ها" />
        <PermissionNotice permission={PERM.roleRead} />
      </>
    );
  }

  const roles = rolesQuery.data?.items ?? [];
  const selectedRole = roleDetailQuery.data;
  const registry = registryQuery.data;
  const isSystemRole = selectedRole?.isSystem === true;
  const editable = canAssign && !isSystemRole;

  const toggleKey = (key: string): void => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <>
      <PageHeader
        title="نقش‌ها و دسترسی‌ها"
        description="ماتریس دسترسی نقش‌ها بر اساس رجیستری مجوزها"
        breadcrumbs={[{ label: 'تنظیمات' }, { label: 'نقش‌ها' }]}
        actions={
          <div className="flex gap-2">
            {canCreate && (
              <Button variant="outline" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
                نقش جدید
              </Button>
            )}
            <Button
              icon={<Save className="size-4" />}
              loading={saveMutation.isPending}
              disabled={!editable || selectedRole === undefined}
              onClick={() => saveMutation.mutate()}
            >
              ذخیره دسترسی‌ها
            </Button>
          </div>
        }
      />

      {rolesQuery.isError && <ErrorState error={rolesQuery.error} onRetry={() => void rolesQuery.refetch()} />}
      {rolesQuery.isLoading && <SkeletonText lines={3} />}

      <div className="grid gap-4 lg:grid-cols-4">
        <Card className="lg:col-span-1">
          <CardHeader title="نقش‌ها" />
          {roles.length === 0 ? (
            <EmptyState title="نقشی ثبت نشده است" />
          ) : (
            <ul className="space-y-1">
              {roles.map((role) => (
                <li key={role.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedRoleId(role.id)}
                    className={`w-full rounded-lg px-2 py-2 text-start text-sm transition-colors ${
                      selectedRoleId === role.id
                        ? 'bg-brand-50 font-medium text-brand-800 dark:bg-brand-950 dark:text-brand-200'
                        : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-1">
                      <span>{role.nameFa ?? role.name ?? role.code}</span>
                      {role.isSystem === true && <Badge tone="neutral">سیستمی</Badge>}
                    </span>
                    <span dir="ltr" className="mt-0.5 block text-[11px] text-slate-400">
                      {role.name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader
            title={selectedRole?.nameFa ?? selectedRole?.name ?? selectedRole?.code ?? 'دسترسی‌ها'}
            description={
              isSystemRole
                ? 'نقش سیستمی قابل ویرایش نیست؛ برای سفارشی‌سازی یک نقش جدید بسازید.'
                : 'دسترسی‌های این نقش را انتخاب کنید.'
            }
            actions={
              selectedRole?.permissions === undefined ? undefined : (
                <Badge tone="brand">{formatNumber(selectedKeys.size)} دسترسی</Badge>
              )
            }
          />

          {roleDetailQuery.isError && (
            <ErrorState error={roleDetailQuery.error} onRetry={() => void roleDetailQuery.refetch()} />
          )}
          {!canReadPermissions && (
            <p className="mb-2 text-xs text-slate-500">
              برای مشاهده رجیستری کامل مجوزها به دسترسی permission.read نیاز دارید.
            </p>
          )}
          {roleDetailQuery.isLoading || registryQuery.isLoading ? (
            <SkeletonText lines={8} />
          ) : registry === undefined ? (
            <EmptyState
              icon={<ShieldCheck className="size-9" />}
              title="رجیستری دسترسی‌ها در دسترس نیست"
              description="برای ویرایش ماتریس دسترسی، رجیستری مجوزها باید از سرور دریافت شود."
            />
          ) : (
            <div className="space-y-4">
              {(registry.groups ?? []).map((group) => (
                <section key={group.resource}>
                  <h3 dir="ltr" className="mb-1 text-start text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {group.resource}
                  </h3>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {group.permissions.map((permission) => (
                      <Checkbox
                        key={permission.key}
                        label={permission.descriptionFa ?? permission.key}
                        description={permission.key}
                        dir="ltr"
                        checked={selectedKeys.has(permission.key)}
                        disabled={!editable}
                        onChange={() => toggleKey(permission.key)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="ایجاد نقش جدید"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              انصراف
            </Button>
            <Button
              loading={createMutation.isPending}
              disabled={newName.trim() === '' || newNameFa.trim() === ''}
              onClick={() => createMutation.mutate()}
            >
              ایجاد نقش
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField label="نام فارسی نقش" required>
            <Input value={newNameFa} onChange={(event) => setNewNameFa(event.target.value)} placeholder="مدیر انبار" />
          </FormField>
          <FormField label="نام لاتین (کد)" required hint="فقط حروف کوچک، عدد و زیرخط">
            <Input
              dir="ltr"
              className="text-left"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="warehouse_manager"
            />
          </FormField>
          <FormField label="توضیحات" hint="اختیاری">
            <Textarea rows={2} value={newDescription} onChange={(event) => setNewDescription(event.target.value)} />
          </FormField>
        </div>
      </Modal>
    </>
  );
}
