/**
 * SMS administration screen (Persian RTL): Limo templates, the outbound message
 * log, 7-day status counters and an operator test-send card.
 *
 * Permissions (existing keys only): `sms.read`, `sms.template.manage`, `sms.send`.
 * The route is wired outside this file; the page is exported as `SmsPage`.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  FlaskConical,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
} from 'lucide-react';

import { api, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { formatJalaliDateTime } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { formatNumber } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import { PermissionNotice } from '../components/auth/Can';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { StatCard } from '../components/ui/StatCard';
import { Switch } from '../components/ui/Switch';
import { TabPanel, Tabs } from '../components/ui/Tabs';
import { DataTable, type Column } from '../components/ui/Table';
import { Textarea } from '../components/ui/Textarea';
import { useToast } from '../components/ui/Toast';

interface SmsTemplate {
  readonly id: string;
  readonly code: string;
  readonly nameFa: string | null;
  readonly body: string | null;
  readonly variables: readonly string[];
  readonly isActive: boolean;
  readonly purpose: string;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
}

interface SmsMessage {
  readonly id: string;
  readonly to: string;
  readonly body: string;
  readonly status: string;
  readonly provider: string;
  readonly providerMessageId: string | null;
  readonly error: string | null;
  readonly purpose: string | null;
  readonly createdAt: string | null;
  readonly templateCode: string | null;
}

interface SmsStats {
  readonly windowDays: number;
  readonly from: string;
  readonly to: string;
  readonly total: number;
  readonly byStatus: readonly { readonly status: string; readonly count: number }[];
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'در صف',
  sent: 'ارسال‌شده',
  delivered: 'تحویل‌شده',
  failed: 'ناموفق',
  rejected: 'رد‌شده',
};

const STATUS_OPTIONS = [
  { value: '', label: 'همهٔ وضعیت‌ها' },
  ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
];

const TABS = [
  { value: 'templates', label: 'قالب‌ها', icon: <MessageSquare aria-hidden className="size-4" /> },
  { value: 'messages', label: 'پیام‌های ارسالی', icon: <Send aria-hidden className="size-4" /> },
  { value: 'stats', label: 'آمار', icon: <BarChart3 aria-hidden className="size-4" /> },
];

function templateFormFrom(template: SmsTemplate | null): {
  code: string;
  nameFa: string;
  body: string;
  variables: string;
  isActive: boolean;
  purpose: string;
} {
  return {
    code: template?.code ?? '',
    nameFa: template?.nameFa ?? '',
    body: template?.body ?? '',
    variables: template?.variables.join(', ') ?? '',
    isActive: template?.isActive ?? true,
    purpose: template?.purpose ?? 'transactional',
  };
}

function variablesFromInput(value: string): string[] {
  return value
    .split(/[,،\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const templateColumns = (
  canManage: boolean,
  onEdit: (template: SmsTemplate) => void,
  onDelete: (template: SmsTemplate) => void,
): readonly Column<SmsTemplate>[] => [
  { key: 'code', header: 'کد', render: (row) => <code dir="ltr" className="text-xs">{row.code}</code> },
  { key: 'nameFa', header: 'نام', render: (row) => row.nameFa ?? '—' },
  {
    key: 'body',
    header: 'متن قالب',
    render: (row) => (
      <span className="block max-w-80 truncate text-xs text-slate-600 dark:text-slate-300" title={row.body ?? ''}>
        {row.body ?? '—'}
      </span>
    ),
  },
  {
    key: 'variables',
    header: 'متغیرها',
    render: (row) =>
      row.variables.length === 0 ? (
        <span className="text-xs text-slate-400">—</span>
      ) : (
        <span className="flex flex-wrap gap-1">
          {row.variables.map((variable) => (
            <Badge key={variable} tone="info">
              <span dir="ltr">{variable}</span>
            </Badge>
          ))}
        </span>
      ),
  },
  {
    key: 'isActive',
    header: 'وضعیت',
    render: (row) => (
      <Badge tone={row.isActive ? 'success' : 'neutral'}>{row.isActive ? 'فعال' : 'غیرفعال'}</Badge>
    ),
  },
  ...(canManage
    ? [
        {
          key: 'actions',
          header: 'عملیات',
          align: 'end' as const,
          render: (row: SmsTemplate) => (
            <span className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => onEdit(row)}>
                ویرایش
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                icon={<Trash2 className="size-4" />}
                onClick={() => onDelete(row)}
              >
                حذف
              </Button>
            </span>
          ),
        },
      ]
    : []),
];

const messageColumns: readonly Column<SmsMessage>[] = [
  { key: 'createdAt', header: 'زمان', render: (row) => (row.createdAt === null ? '—' : formatJalaliDateTime(row.createdAt)) },
  { key: 'to', header: 'گیرنده', render: (row) => <span dir="ltr">{row.to}</span> },
  {
    key: 'body',
    header: 'متن',
    render: (row) => (
      <span className="block max-w-72 truncate text-xs" title={row.body}>
        {row.body}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'وضعیت',
    render: (row) => (
      <Badge tone={row.status === 'failed' || row.status === 'rejected' ? 'danger' : row.status === 'sent' || row.status === 'delivered' ? 'success' : 'neutral'}>
        {STATUS_LABELS[row.status] ?? row.status}
      </Badge>
    ),
  },
  { key: 'provider', header: 'سرویس‌دهنده', render: (row) => <span dir="ltr" className="text-xs">{row.provider}</span> },
  { key: 'templateCode', header: 'قالب', render: (row) => (row.templateCode === null ? '—' : <span dir="ltr" className="text-xs">{row.templateCode}</span>) },
  {
    key: 'providerMessageId',
    header: 'شناسهٔ سرویس‌دهنده',
    render: (row) =>
      row.providerMessageId === null ? (
        '—'
      ) : (
        <span dir="ltr" className="text-xs">{row.providerMessageId}</span>
      ),
  },
  {
    key: 'error',
    header: 'خطا',
    render: (row) =>
      row.error === null ? (
        '—'
      ) : (
        <span dir="ltr" className="text-xs text-red-600 dark:text-red-400">
          {row.error}
        </span>
      ),
  },
];

/** SMS admin: templates CRUD, message log with filters, status counters, test send. */
export function SmsPage() {
  useDocumentTitle('پیامک');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasPermission(PERM.smsRead);
  const canManage = useHasPermission(PERM.smsTemplateManage);
  const canSend = useHasPermission(PERM.smsSend);

  const [tab, setTab] = useState('templates');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SmsTemplate | null>(null);
  const [form, setForm] = useState(templateFormFrom(null));
  const [deleteTarget, setDeleteTarget] = useState<SmsTemplate | null>(null);

  const [statusFilter, setStatusFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [appliedFilters, setAppliedFilters] = useState<{
    status: string;
    from: string;
    to: string;
  }>({ status: '', from: '', to: '' });

  const [testMobile, setTestMobile] = useState('');
  const [testBody, setTestBody] = useState('');

  const templatesQuery = useQuery({
    queryKey: queryKeys.sms.templates,
    queryFn: () => api.get<SmsTemplate[]>('/sms/templates'),
    enabled: canRead,
  });

  const messagesQuery = useQuery({
    queryKey: queryKeys.sms.messages(appliedFilters),
    queryFn: () => {
      const params: Record<string, string> = { limit: '100' };
      if (appliedFilters.status !== '') params['status'] = appliedFilters.status;
      if (appliedFilters.from !== '') params['from'] = `${appliedFilters.from}T00:00:00.000Z`;
      if (appliedFilters.to !== '') params['to'] = `${appliedFilters.to}T23:59:59.999Z`;
      return api.get<SmsMessage[]>('/sms/messages', params);
    },
    enabled: canRead && tab === 'messages',
  });

  const statsQuery = useQuery({
    queryKey: queryKeys.sms.stats,
    queryFn: () => api.get<SmsStats>('/sms/stats'),
    enabled: canRead && tab === 'stats',
  });

  const invalidateTemplates = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.sms.templates });
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        code: form.code.trim(),
        nameFa: form.nameFa.trim(),
        body: form.body.trim(),
        variables: variablesFromInput(form.variables),
        isActive: form.isActive,
        purpose: form.purpose.trim() === '' ? 'transactional' : form.purpose.trim(),
      };
      return editing === null
        ? api.post<SmsTemplate>('/sms/templates', payload, { idempotencyKey: newRequestId() })
        : api.patch<SmsTemplate>(`/sms/templates/${editing.id}`, payload);
    },
    onSuccess: () => {
      toast.success(editing === null ? 'قالب ایجاد شد' : 'قالب ویرایش شد');
      setEditorOpen(false);
      setEditing(null);
      setForm(templateFormFrom(null));
      invalidateTemplates();
    },
    onError: (error) => toast.error('ذخیرهٔ قالب ناموفق بود', toFaErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (template: SmsTemplate) => api.del<{ id: string }>(`/sms/templates/${template.id}`),
    onSuccess: () => {
      toast.success('قالب حذف شد');
      setDeleteTarget(null);
      invalidateTemplates();
    },
    onError: (error) => toast.error('حذف قالب ناموفق بود', toFaErrorMessage(error)),
  });

  const testMutation = useMutation({
    mutationFn: () => api.post<{ ok: boolean; providerMessageId: string | null; provider: string }>(
      '/sms/test',
      { mobile: testMobile.trim(), body: testBody.trim() },
      { idempotencyKey: newRequestId() },
    ),
    onSuccess: (result) => {
      toast.success(
        'پیامک آزمایشی ارسال شد',
        result.providerMessageId === null
          ? 'سرویس‌دهنده شناسهٔ پیام برنگرداند.'
          : `شناسهٔ سرویس‌دهنده: ${result.providerMessageId}`,
      );
      setTestBody('');
      void queryClient.invalidateQueries({ queryKey: ['sms', 'messages'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sms.stats });
    },
    onError: (error) => toast.error('ارسال آزمایشی ناموفق بود', toFaErrorMessage(error)),
  });

  const openCreate = (): void => {
    setEditing(null);
    setForm(templateFormFrom(null));
    setEditorOpen(true);
  };

  const openEdit = (template: SmsTemplate): void => {
    setEditing(template);
    setForm(templateFormFrom(template));
    setEditorOpen(true);
  };

  const totals = useMemo(() => {
    const stats = statsQuery.data;
    if (stats === undefined) return null;
    return {
      ...stats,
      failed: stats.byStatus.find((row) => row.status === 'failed')?.count ?? 0,
      sent: stats.byStatus.find((row) => row.status === 'sent')?.count ?? 0,
      delivered: stats.byStatus.find((row) => row.status === 'delivered')?.count ?? 0,
    };
  }, [statsQuery.data]);

  if (!canRead) {
    return (
      <div className="space-y-4">
        <PageHeader title="پیامک" description="مدیریت قالب‌ها و پیام‌های ارسالی" />
        <PermissionNotice permission={PERM.smsRead} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="پیامک"
        description="قالب‌های Limo، پیام‌های ارسالی، آمار هفت‌روزه و ارسال آزمایشی"
        actions={
          <Button
            variant="outline"
            icon={<RefreshCw className="size-4" />}
            onClick={() => {
              void templatesQuery.refetch();
              if (tab === 'messages') void messagesQuery.refetch();
              if (tab === 'stats') void statsQuery.refetch();
            }}
          >
            بازخوانی
          </Button>
        }
      />

      <Tabs items={TABS} value={tab} onChange={setTab} ariaLabel="بخش‌های پیامک" />

      <TabPanel value={tab}>
        {tab === 'templates' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                متغیرها با <code dir="ltr">{'{{نام}}'}</code> در متن قالب جای‌گذاری می‌شوند و هنگام ارسال مقدار می‌گیرند.
              </p>
              {canManage && (
                <Button icon={<Plus className="size-4" />} onClick={openCreate}>
                  قالب جدید
                </Button>
              )}
            </div>
            <DataTable
              columns={templateColumns(canManage, openEdit, setDeleteTarget)}
              rows={templatesQuery.data ?? []}
              rowKey={(row) => row.id}
              loading={templatesQuery.isLoading}
              error={templatesQuery.error}
              onRetry={() => void templatesQuery.refetch()}
              emptyTitle="هنوز قالبی ثبت نشده است"
              emptyDescription={canManage ? 'برای شروع یک قالب Limo بسازید.' : 'مدیر سامانه هنوز قالبی ثبت نکرده است.'}
              emptyAction={
                canManage ? (
                  <Button icon={<Plus className="size-4" />} onClick={openCreate}>
                    قالب جدید
                  </Button>
                ) : undefined
              }
              caption="قالب‌های پیامک"
            />
          </div>
        )}

        {tab === 'messages' && (
          <div className="space-y-3">
            <Card padding="sm">
              <div className="flex flex-wrap items-end gap-3">
                <FormField label="وضعیت" className="w-44">
                  <Select
                    options={STATUS_OPTIONS}
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value)}
                    aria-label="فیلتر وضعیت"
                  />
                </FormField>
                <FormField label="از تاریخ" className="w-44">
                  <Input
                    type="date"
                    value={fromDate}
                    onChange={(event) => setFromDate(event.target.value)}
                    aria-label="از تاریخ"
                  />
                </FormField>
                <FormField label="تا تاریخ" className="w-44">
                  <Input
                    type="date"
                    value={toDate}
                    onChange={(event) => setToDate(event.target.value)}
                    aria-label="تا تاریخ"
                  />
                </FormField>
                <Button
                  variant="secondary"
                  icon={<RefreshCw className="size-4" />}
                  onClick={() => {
                    setAppliedFilters({ status: statusFilter, from: fromDate, to: toDate });
                    if (
                      appliedFilters.status === statusFilter &&
                      appliedFilters.from === fromDate &&
                      appliedFilters.to === toDate
                    ) {
                      void messagesQuery.refetch();
                    }
                  }}
                >
                  اعمال فیلتر
                </Button>
              </div>
            </Card>
            <DataTable
              columns={messageColumns}
              rows={messagesQuery.data ?? []}
              rowKey={(row) => row.id}
              loading={messagesQuery.isLoading}
              error={messagesQuery.error}
              onRetry={() => void messagesQuery.refetch()}
              emptyTitle="پیامی در این بازه یافت نشد"
              emptyDescription="فیلترها را بازتر کنید یا بازهٔ زمانی دیگری انتخاب کنید."
              caption="پیام‌های ارسالی"
            />
          </div>
        )}

        {tab === 'stats' && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                title="کل پیامک‌ها (۷ روز)"
                value={totals === null ? '—' : formatNumber(totals.total)}
                loading={statsQuery.isLoading}
                tone="brand"
                hint={totals === null ? undefined : `از ${formatJalaliDateTime(totals.from)}`}
              />
              <StatCard
                title="ارسال‌شده"
                value={totals === null ? '—' : formatNumber(totals.sent)}
                loading={statsQuery.isLoading}
                tone="success"
              />
              <StatCard
                title="تحویل‌شده"
                value={totals === null ? '—' : formatNumber(totals.delivered)}
                loading={statsQuery.isLoading}
                tone="success"
              />
              <StatCard
                title="ناموفق"
                value={totals === null ? '—' : formatNumber(totals.failed)}
                loading={statsQuery.isLoading}
                tone="danger"
              />
            </div>

            <Card>
              <CardHeader title="شمارش به تفکیک وضعیت (۷ روز گذشته)" />
              {statsQuery.isLoading && <p className="text-sm text-slate-500">در حال بارگذاری…</p>}
              {statsQuery.error !== null && statsQuery.error !== undefined && (
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {toFaErrorMessage(statsQuery.error)}
                </p>
              )}
              {totals !== null && (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {totals.byStatus.map((row) => (
                    <li key={row.status} className="flex items-center justify-between py-2 text-sm">
                      <Badge
                        tone={
                          row.status === 'failed' || row.status === 'rejected'
                            ? 'danger'
                            : row.status === 'sent' || row.status === 'delivered'
                              ? 'success'
                              : 'neutral'
                        }
                      >
                        {STATUS_LABELS[row.status] ?? row.status}
                      </Badge>
                      <span className="font-medium tabular">{formatNumber(row.count)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <FlaskConical aria-hidden className="size-4 text-brand-700" />
                    ارسال آزمایشی
                  </span>
                }
                description="پیام از طریق سرویس Limo ارسال و در «پیام‌های ارسالی» ثبت می‌شود. در حالت mock ارسال واقعی انجام نمی‌شود."
              />
              {canSend ? (
                <form
                  className="grid gap-3 sm:grid-cols-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    testMutation.mutate();
                  }}
                >
                  <FormField label="شماره موبایل" htmlFor="sms-test-mobile" required>
                    <Input
                      id="sms-test-mobile"
                      dir="ltr"
                      inputMode="tel"
                      placeholder="09xxxxxxxxx"
                      value={testMobile}
                      onChange={(event) => setTestMobile(event.target.value)}
                    />
                  </FormField>
                  <FormField label="متن پیامک" htmlFor="sms-test-body" required className="sm:col-span-2">
                    <Textarea
                      id="sms-test-body"
                      rows={3}
                      maxLength={500}
                      placeholder="متن پیام آزمایشی…"
                      value={testBody}
                      onChange={(event) => setTestBody(event.target.value)}
                    />
                  </FormField>
                  <div className="sm:col-span-2">
                    <Button
                      type="submit"
                      icon={<Send className="size-4" />}
                      loading={testMutation.isPending}
                      disabled={testMobile.trim() === '' || testBody.trim() === ''}
                    >
                      ارسال آزمایشی
                    </Button>
                  </div>
                </form>
              ) : (
                <EmptyState
                  title="دسترسی ارسال پیامک ندارید"
                  description="برای ارسال آزمایشی به کلید دسترسی sms.send نیاز است."
                />
              )}
            </Card>
          </div>
        )}
      </TabPanel>

      <Modal
        open={editorOpen}
        onClose={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
        title={editing === null ? 'قالب پیامک جدید' : 'ویرایش قالب پیامک'}
        description="کد قالبی که در Limo ثبت شده و متن فارسی آن را وارد کنید."
        size="lg"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setEditorOpen(false);
                setEditing(null);
              }}
            >
              انصراف
            </Button>
            <Button
              loading={saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
              icon={<Send className="size-4" />}
            >
              ذخیره
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="کد قالب" htmlFor="sms-template-code" required hint="حروف کوچک لاتین، عدد، نقطه، خط تیره">
            <Input
              id="sms-template-code"
              dir="ltr"
              value={form.code}
              onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
              placeholder="otp_login"
            />
          </FormField>
          <FormField label="نام فارسی" htmlFor="sms-template-name" required>
            <Input
              id="sms-template-name"
              value={form.nameFa}
              onChange={(event) => setForm((current) => ({ ...current, nameFa: event.target.value }))}
              placeholder="کد ورود"
            />
          </FormField>
          <FormField label="هدف" htmlFor="sms-template-purpose" hint="مثلاً login یا transactional">
            <Input
              id="sms-template-purpose"
              dir="ltr"
              value={form.purpose}
              onChange={(event) => setForm((current) => ({ ...current, purpose: event.target.value }))}
            />
          </FormField>
          <div className="flex items-end pb-1">
            <Switch
              label="فعال"
              checked={form.isActive}
              onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.checked }))}
            />
          </div>
          <FormField
            label="متن قالب"
            htmlFor="sms-template-body"
            required
            className="sm:col-span-2"
            hint="مثال: کد ورود شما {{code}} است."
          >
            <Textarea
              id="sms-template-body"
              rows={5}
              maxLength={2000}
              value={form.body}
              onChange={(event) => setForm((current) => ({ ...current, body: event.target.value }))}
              placeholder="متن پیامک با جای‌گذار متغیرها…"
            />
          </FormField>
          <FormField
            label="متغیرها"
            htmlFor="sms-template-variables"
            className="sm:col-span-2"
            hint="با کاما جدا کنید؛ ترتیب متغیرها همان ترتیب ReplaceToken در Limo است."
          >
            <Input
              id="sms-template-variables"
              dir="ltr"
              value={form.variables}
              onChange={(event) => setForm((current) => ({ ...current, variables: event.target.value }))}
              placeholder="code, orderNo"
            />
          </FormField>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="حذف قالب پیامک"
        description={
          deleteTarget === null
            ? undefined
            : `قالب «${deleteTarget.nameFa ?? deleteTarget.code}» حذف (غیرفعال) می‌شود. سابقهٔ پیام‌های ارسالی حفظ می‌شود.`
        }
        confirmLabel="حذف"
        tone="danger"
        loading={deleteMutation.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget !== null) deleteMutation.mutate(deleteTarget);
        }}
      />
    </div>
  );
}
