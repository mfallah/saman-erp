import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { api, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { useDocumentTitle } from '../lib/hooks';
import { PERM } from '../lib/permissions';
import { useHasPermission } from '../lib/use-auth';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, type Column } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';

interface PriceList {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly channelName?: string | null;
}

interface PricingRule {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly priceListId?: string | null;
  readonly priceListName?: string | null;
  readonly priority: number;
  readonly markupPercent: string;
  readonly fixedMarkupAmount: string;
  readonly commissionPercent: string;
  readonly fixedFeeAmount: string;
  readonly taxPercent: string;
  readonly shippingFeeAmount: string;
  readonly minimumMarginPercent: string;
  readonly roundingIncrement: string;
  readonly isActive: boolean;
}

interface RuleForm {
  code: string;
  name: string;
  priceListId: string;
  priority: string;
  markupPercent: string;
  fixedMarkupAmount: string;
  commissionPercent: string;
  fixedFeeAmount: string;
  taxPercent: string;
  shippingFeeAmount: string;
  minimumMarginPercent: string;
  roundingIncrement: string;
  isActive: boolean;
}

const emptyForm: RuleForm = {
  code: '',
  name: '',
  priceListId: '',
  priority: '0',
  markupPercent: '0',
  fixedMarkupAmount: '0',
  commissionPercent: '0',
  fixedFeeAmount: '0',
  taxPercent: '0',
  shippingFeeAmount: '0',
  minimumMarginPercent: '0',
  roundingIncrement: '1000',
  isActive: true,
};

export function PricingRulesPage() {
  useDocumentTitle('قواعد قیمت‌گذاری');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasPermission(PERM.pricingRuleRead);
  const canCreate = useHasPermission(PERM.pricingRuleCreate);
  const canUpdate = useHasPermission(PERM.pricingRuleUpdate);
  const canDelete = useHasPermission(PERM.pricingRuleDelete);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PricingRule | null>(null);
  const [form, setForm] = useState<RuleForm>(emptyForm);

  const listsQuery = useQuery({
    queryKey: ['pricing', 'lists'],
    queryFn: () => api.get<readonly PriceList[]>('/pricing/lists'),
    enabled: canRead,
  });
  const rulesQuery = useQuery({
    queryKey: ['pricing', 'rules'],
    queryFn: () => api.get<readonly PricingRule[]>('/pricing/rules'),
    enabled: canRead,
  });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        code: form.code.trim(),
        name: form.name.trim(),
        ...(form.priceListId === '' ? {} : { priceListId: form.priceListId }),
        priority: Number(form.priority),
        markupPercent: Number(form.markupPercent),
        fixedMarkupAmount: Number(form.fixedMarkupAmount),
        commissionPercent: Number(form.commissionPercent),
        fixedFeeAmount: Number(form.fixedFeeAmount),
        taxPercent: Number(form.taxPercent),
        shippingFeeAmount: Number(form.shippingFeeAmount),
        minimumMarginPercent: Number(form.minimumMarginPercent),
        roundingIncrement: Number(form.roundingIncrement),
        isActive: form.isActive,
      };
      return editing === null
        ? api.post('/pricing/rules', payload, { idempotencyKey: newRequestId() })
        : api.put(`/pricing/rules/${editing.id}`, payload);
    },
    onSuccess: () => {
      toast.success(editing === null ? 'قاعدهٔ قیمت ساخته شد' : 'قاعدهٔ قیمت ویرایش شد');
      setOpen(false);
      setEditing(null);
      setForm(emptyForm);
      void queryClient.invalidateQueries({ queryKey: ['pricing', 'rules'] });
    },
    onError: (error) => toast.error('ذخیرهٔ قاعده ناموفق بود', toFaErrorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/pricing/rules/${id}`),
    onSuccess: () => {
      toast.success('قاعده حذف شد');
      void queryClient.invalidateQueries({ queryKey: ['pricing', 'rules'] });
    },
    onError: (error) => toast.error('حذف قاعده ناموفق بود', toFaErrorMessage(error)),
  });

  const startEdit = (rule: PricingRule): void => {
    setEditing(rule);
    setForm({
      code: rule.code,
      name: rule.name,
      priceListId: rule.priceListId ?? '',
      priority: String(rule.priority),
      markupPercent: rule.markupPercent,
      fixedMarkupAmount: rule.fixedMarkupAmount,
      commissionPercent: rule.commissionPercent,
      fixedFeeAmount: rule.fixedFeeAmount,
      taxPercent: rule.taxPercent,
      shippingFeeAmount: rule.shippingFeeAmount,
      minimumMarginPercent: rule.minimumMarginPercent,
      roundingIncrement: rule.roundingIncrement,
      isActive: rule.isActive,
    });
    setOpen(true);
  };

  const update = <K extends keyof RuleForm>(key: K, value: RuleForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const columns: readonly Column<PricingRule>[] = [
    { key: 'code', header: 'کد', render: (rule) => <span dir="ltr">{rule.code}</span> },
    { key: 'name', header: 'نام', render: (rule) => rule.name },
    { key: 'list', header: 'لیست قیمت', render: (rule) => rule.priceListName ?? '—' },
    {
      key: 'markup',
      header: 'درصد سود',
      render: (rule) => <span className="tabular">{Number(rule.markupPercent).toLocaleString('fa-IR')}٪</span>,
    },
    {
      key: 'commission',
      header: 'کمیسیون',
      render: (rule) => <span className="tabular">{Number(rule.commissionPercent).toLocaleString('fa-IR')}٪</span>,
    },
    {
      key: 'fixed',
      header: 'هزینهٔ ثابت',
      render: (rule) => <span className="tabular">{Number(rule.fixedFeeAmount).toLocaleString('fa-IR')}</span>,
    },
    {
      key: 'active',
      header: 'وضعیت',
      render: (rule) => <Badge tone={rule.isActive ? 'success' : 'neutral'}>{rule.isActive ? 'فعال' : 'غیرفعال'}</Badge>,
    },
    {
      key: 'actions',
      header: 'عملیات',
      render: (rule) => (
        <div className="flex gap-1">
          {canUpdate ? (
            <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} onClick={() => startEdit(rule)}>
              ویرایش
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              size="sm"
              variant="outline"
              icon={<Trash2 className="size-3.5" />}
              loading={remove.isPending}
              onClick={() => {
                if (window.confirm(`قاعدهٔ ${rule.name} حذف شود؟`)) remove.mutate(rule.id);
              }}
            >
              حذف
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  if (!canRead) {
    return (
      <>
        <PageHeader title="قواعد قیمت‌گذاری" />
        <Card>
          <p className="text-sm text-slate-500">برای مشاهدهٔ قواعد به مجوز قیمت‌گذاری نیاز دارید.</p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="قواعد قیمت‌گذاری"
        description="قواعد markup، کمیسیون، مالیات و هزینهٔ ثابت هر لیست قیمت/کانال"
        breadcrumbs={[{ label: 'قیمت‌گذاری' }]}
        actions={
          canCreate ? (
            <Button
              icon={<Plus className="size-4" />}
              onClick={() => {
                setEditing(null);
                setForm({ ...emptyForm, priceListId: listsQuery.data?.[0]?.id ?? '' });
                setOpen(true);
              }}
            >
              قاعدهٔ جدید
            </Button>
          ) : undefined
        }
      />

      <Card>
        <CardHeader
          title="فهرست قواعد"
          description="قاعده‌ای که اولویت بالاتری دارد زودتر اعمال می‌شود؛ خالی‌بودن فهرست یعنی هنوز قاعده‌ای ثبت نشده است."
        />
        <DataTable
          columns={columns}
          rows={rulesQuery.data ?? []}
          rowKey={(rule) => rule.id}
          loading={rulesQuery.isLoading}
          caption="قواعد قیمت‌گذاری"
          emptyTitle="هنوز قاعده‌ای ثبت نشده است"
          emptyDescription="با «قاعدهٔ جدید» اولین سیاست قیمت‌گذاری را بساز."
        />
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing === null ? 'قاعدهٔ قیمت‌گذاری جدید' : 'ویرایش قاعده'}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              انصراف
            </Button>
            <Button
              loading={save.isPending}
              disabled={form.code.trim().length < 2 || form.name.trim().length < 2}
              onClick={() => save.mutate()}
            >
              ذخیره قاعده
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="کد قاعده" required>
            <Input dir="ltr" value={form.code} onChange={(event) => update('code', event.target.value)} />
          </FormField>
          <FormField label="نام قاعده" required>
            <Input value={form.name} onChange={(event) => update('name', event.target.value)} />
          </FormField>
          <FormField label="لیست قیمت / کانال">
            <select
              className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-900"
              value={form.priceListId}
              onChange={(event) => update('priceListId', event.target.value)}
            >
              <option value="">لیست پایه</option>
              {(listsQuery.data ?? []).map((list) => (
                <option key={list.id} value={list.id}>
                  {list.channelName === null || list.channelName === undefined ? list.name : `${list.name} — ${list.channelName}`}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="اولویت">
            <Input dir="ltr" value={form.priority} onChange={(event) => update('priority', event.target.value)} />
          </FormField>
          <FormField label="درصد سود (markup)">
            <Input dir="ltr" value={form.markupPercent} onChange={(event) => update('markupPercent', event.target.value)} />
          </FormField>
          <FormField label="سود ثابت (ریال)">
            <Input dir="ltr" value={form.fixedMarkupAmount} onChange={(event) => update('fixedMarkupAmount', event.target.value)} />
          </FormField>
          <FormField label="درصد کمیسیون">
            <Input dir="ltr" value={form.commissionPercent} onChange={(event) => update('commissionPercent', event.target.value)} />
          </FormField>
          <FormField label="هزینهٔ ثابت (ریال)">
            <Input dir="ltr" value={form.fixedFeeAmount} onChange={(event) => update('fixedFeeAmount', event.target.value)} />
          </FormField>
          <FormField label="درصد مالیات">
            <Input dir="ltr" value={form.taxPercent} onChange={(event) => update('taxPercent', event.target.value)} />
          </FormField>
          <FormField label="هزینهٔ ارسال (ریال)">
            <Input dir="ltr" value={form.shippingFeeAmount} onChange={(event) => update('shippingFeeAmount', event.target.value)} />
          </FormField>
          <FormField label="حداقل حاشیهٔ سود">
            <Input dir="ltr" value={form.minimumMarginPercent} onChange={(event) => update('minimumMarginPercent', event.target.value)} />
          </FormField>
          <FormField label="گرد کردن به">
            <Input dir="ltr" value={form.roundingIncrement} onChange={(event) => update('roundingIncrement', event.target.value)} />
          </FormField>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isActive} onChange={(event) => update('isActive', event.target.checked)} />
            فعال باشد
          </label>
        </div>
      </Modal>
    </>
  );
}
