import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Plus, Save, Scale, Trash2 } from 'lucide-react';
import { api, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { formatJalaliInput, parseJalaliInput, todayISO } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { addMoney, formatMoney, parseMoney } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import type { Account, JournalEntryDetail } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { useHasPermission } from '../lib/use-auth';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { Combobox } from '../components/ui/Combobox';
import { ErrorState } from '../components/ui/ErrorState';
import { FormField } from '../components/ui/FormField';
import { IconButton } from '../components/ui/IconButton';
import { Input } from '../components/ui/Input';
import { MoneyInput } from '../components/ui/MoneyInput';
import { PageHeader } from '../components/ui/PageHeader';
import { useToast } from '../components/ui/Toast';

interface JournalLineDraft {
  readonly key: string;
  accountId: string;
  debit: string;
  credit: string;
  description: string;
}

let lineSeed = 3;

export function makeLine(key?: string): JournalLineDraft {
  return {
    key: key ?? `line-${++lineSeed}`,
    accountId: '',
    debit: '',
    credit: '',
    description: '',
  };
}

/** Manual balanced journal entry with live debit/credit totals. */
export function JournalCreatePage() {
  useDocumentTitle('سند حسابداری جدید');
  const canCreate = useHasPermission(PERM.journalCreate);
  const navigate = useNavigate();
  const toast = useToast();
  const [dateText, setDateText] = useState(() => formatJalaliInput(todayISO()));
  const [dateError, setDateError] = useState<string | undefined>(undefined);
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<readonly JournalLineDraft[]>([
    makeLine('line-1'),
    makeLine('line-2'),
  ]);

  const accountsQuery = useQuery({
    queryKey: queryKeys.accounting.accounts({ postable: true }),
    queryFn: () => api.getPage<Account>('/accounting/accounts', { perPage: 500, 'filter[active]': true }),
    enabled: canCreate,
    staleTime: 5 * 60_000,
  });

  const accountOptions = (accountsQuery.data?.items ?? []).map((account) => ({
    value: account.id,
    label: `${account.code} — ${account.nameFa}`,
  }));

  const isoDate = useMemo(() => {
    try {
      return parseJalaliInput(dateText);
    } catch {
      return null;
    }
  }, [dateText]);

  const totals = useMemo(() => {
    let debit = 0n;
    let credit = 0n;
    for (const line of lines) {
      try {
        if (line.debit !== '') {
          debit = addMoney(debit, parseMoney(line.debit));
        }
        if (line.credit !== '') {
          credit = addMoney(credit, parseMoney(line.credit));
        }
      } catch {
        // Invalid intermediate input is ignored for totals; validation blocks submit.
      }
    }
    return { debit, credit, balanced: debit === credit && debit > 0n };
  }, [lines]);

  const validLines =
    description.trim().length >= 2 &&
    isoDate !== null &&
    lines.length >= 2 &&
    lines.every(
      (line) =>
        line.accountId !== '' &&
        (line.debit !== '' || line.credit !== '') &&
        !(line.debit !== '' && line.credit !== ''),
    );

  const mutation = useMutation({
    mutationFn: () =>
      api.post<JournalEntryDetail>(
        '/accounting/journal-entries',
        {
          date: isoDate,
          description: description.trim(),
          lines: lines.map((line) => ({
            accountId: line.accountId,
            debit: line.debit === '' ? '0' : line.debit,
            credit: line.credit === '' ? '0' : line.credit,
            ...(line.description.trim() === '' ? {} : { description: line.description.trim() }),
          })),
        },
        { idempotencyKey: newRequestId() },
      ),
    onSuccess: () => {
      toast.success('سند ثبت شد', 'سند حسابداری به‌صورت پیش‌نویس ایجاد شد.');
      void navigate({ to: '/accounting/journals' });
    },
    onError: (error) => toast.error('ثبت سند ناموفق بود', toFaErrorMessage(error)),
  });

  if (!canCreate) {
    return (
      <>
        <PageHeader title="سند حسابداری جدید" />
        <PermissionNotice permission={PERM.journalCreate} />
      </>
    );
  }

  const difference = totals.debit > totals.credit ? totals.debit - totals.credit : totals.credit - totals.debit;

  return (
    <>
      <PageHeader
        title="سند حسابداری جدید"
        description="جمع بدهکار و بستانکار باید برابر باشد."
        breadcrumbs={[
          { label: 'مالی' },
          { label: 'دفتر روزنامه', to: '/accounting/journals' },
          { label: 'سند جدید' },
        ]}
        actions={
          <>
            <Button
              variant="outline"
              icon={<ArrowLeft className="size-4" />}
              onClick={() => void navigate({ to: '/accounting/journals' })}
            >
              بازگشت
            </Button>
            <Button
              icon={<Save className="size-4" />}
              loading={mutation.isPending}
              disabled={!validLines || !totals.balanced}
              onClick={() => mutation.mutate()}
            >
              ثبت سند
            </Button>
          </>
        }
      />

      {accountsQuery.isError && (
        <div className="mb-4">
          <ErrorState
            title="دریافت کدینگ حساب‌ها ناموفق بود"
            message="ثبت سند بدون کدینگ حساب‌ها ممکن نیست."
            onRetry={() => void accountsQuery.refetch()}
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-4">
        <Card className="lg:col-span-3">
          <CardHeader title="اقلام سند" description="برای هر ردیف، حساب و مبلغ بدهکار یا بستانکار را وارد کنید." />
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <FormField label="تاریخ سند (شمسی)" htmlFor="journal-date" required {...(dateError === undefined ? {} : { error: dateError })}>
                <Input
                  id="journal-date"
                  dir="ltr"
                  className="text-left"
                  value={dateText}
                  invalid={dateError !== undefined}
                  onChange={(event) => {
                    setDateText(event.target.value);
                    try {
                      parseJalaliInput(event.target.value);
                      setDateError(undefined);
                    } catch (error) {
                      setDateError(error instanceof Error ? error.message : 'تاریخ معتبر نیست.');
                    }
                  }}
                />
              </FormField>
              <FormField label="شرح سند" htmlFor="journal-description" required className="md:col-span-2">
                <Input
                  id="journal-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="شرح کلی سند…"
                />
              </FormField>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  <tr>
                    <th scope="col" className="px-2 py-2 text-start">حساب</th>
                    <th scope="col" className="w-40 px-2 py-2 text-start">بدهکار (ریال)</th>
                    <th scope="col" className="w-40 px-2 py-2 text-start">بستانکار (ریال)</th>
                    <th scope="col" className="px-2 py-2 text-start">شرح ردیف</th>
                    <th scope="col" className="w-10 px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={line.key} className="border-b border-slate-100 dark:border-slate-800">
                      <td className="px-2 py-2">
                        <Combobox
                          options={accountOptions}
                          value={line.accountId}
                          loading={accountsQuery.isLoading}
                          disabled={accountsQuery.isError}
                          placeholder="انتخاب حساب"
                          ariaLabel={`حساب ردیف ${index + 1}`}
                          onChange={(value) =>
                            setLines((current) =>
                              current.map((item) =>
                                item.key === line.key ? { ...item, accountId: value } : item,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <MoneyInput
                          value={line.debit}
                          ariaLabel={`بدهکار ردیف ${index + 1}`}
                          onChange={(value) =>
                            setLines((current) =>
                              current.map((item) =>
                                item.key === line.key ? { ...item, debit: value, credit: value === '' ? item.credit : '' } : item,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <MoneyInput
                          value={line.credit}
                          ariaLabel={`بستانکار ردیف ${index + 1}`}
                          onChange={(value) =>
                            setLines((current) =>
                              current.map((item) =>
                                item.key === line.key ? { ...item, credit: value, debit: value === '' ? item.debit : '' } : item,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <Input
                          value={line.description}
                          aria-label={`شرح ردیف ${index + 1}`}
                          onChange={(event) =>
                            setLines((current) =>
                              current.map((item) =>
                                item.key === line.key ? { ...item, description: event.target.value } : item,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-2 py-2">
                        <IconButton
                          label="حذف ردیف"
                          tone="danger"
                          icon={<Trash2 className="size-4" />}
                          disabled={lines.length <= 2}
                          onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Button
              variant="outline"
              size="sm"
              icon={<Plus className="size-4" />}
              onClick={() => setLines((current) => [...current, makeLine()])}
            >
              افزودن ردیف
            </Button>

            {mutation.isError && (
              <ErrorState message={toFaErrorMessage(mutation.error)} />
            )}
          </div>
        </Card>

        <div className="space-y-3">
          <Card>
            <CardHeader title="جمع‌ها" />
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">جمع بدهکار</dt>
                <dd className="tabular font-medium">{formatMoney(totals.debit)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">جمع بستانکار</dt>
                <dd className="tabular font-medium">{formatMoney(totals.credit)}</dd>
              </div>
              <div className="flex items-center justify-between border-t border-slate-100 pt-2 dark:border-slate-800">
                <dt className="text-slate-500">اختلاف</dt>
                <dd className="tabular font-medium">{formatMoney(difference)}</dd>
              </div>
            </dl>
            <div className="mt-3">
              {totals.balanced ? (
                <Badge tone="success">
                  <Scale aria-hidden className="size-3.5" />
                  سند متوازن است
                </Badge>
              ) : (
                <Badge tone="danger">
                  <Scale aria-hidden className="size-3.5" />
                  سند متوازن نیست
                </Badge>
              )}
            </div>
            <p className="mt-3 text-[11px] text-slate-400">
              مبالغ به ریال و به‌صورت عدد صحیح ({'>'}bigint) محاسبه می‌شوند؛ گرد کردن در سمت سرور انجام می‌شود.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
