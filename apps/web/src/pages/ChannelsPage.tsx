import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, FlaskConical, KeyRound, PlugZap, RefreshCw, RotateCw, Upload } from 'lucide-react';
import { ApiError, api, isNotImplemented, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { formatJalaliDateTime, relativeTimeFa } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { formatNumber } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type {
  Channel,
  ChannelAccount,
  ChannelAccountRsaKeypair,
  ChannelHealthRow,
  RsaKeyCompareResult,
  SyncJob,
} from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { Combobox } from '../components/ui/Combobox';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { TabPanel, Tabs } from '../components/ui/Tabs';
import { DataTable, type Column } from '../components/ui/Table';
import { Textarea } from '../components/ui/Textarea';
import { useToast } from '../components/ui/Toast';

const SYNC_TYPES = [
  { value: 'inventory_push', label: 'ارسال موجودی' },
  { value: 'price_push', label: 'ارسال قیمت' },
  { value: 'order_pull', label: 'دریافت سفارش‌ها' },
  { value: 'product_import', label: 'دریافت محصولات از کانال (اولین همگام‌سازی)' },
  { value: 'product_push', label: 'ارسال محصولات' },
  { value: 'settlement_pull', label: 'دریافت تسویه' },
  { value: 'full_reconcile', label: 'همگام‌سازی کامل' },
];

const healthColumns: readonly Column<ChannelHealthRow>[] = [
  { key: 'channel', header: 'کانال', render: (row) => row.channel?.nameFa ?? row.channel?.name ?? '—' },
  { key: 'account', header: 'حساب', render: (row) => row.account?.name ?? '—' },
  {
    key: 'status',
    header: 'وضعیت',
    render: (row) => (
      <Badge tone={row.status === 'unknown' ? 'neutral' : row.status === 'fail' ? 'danger' : 'success'}>
        {row.status === 'unknown' ? 'بررسی نشده' : row.status === 'fail' ? 'ناموفق' : 'سالم'}
      </Badge>
    ),
  },  {
    key: 'lastSuccessAt',
    header: 'آخرین موفقیت',
    render: (row) => (row.lastSuccessAt === undefined || row.lastSuccessAt === null ? '—' : relativeTimeFa(row.lastSuccessAt)),
  },
  {
    key: 'failureStreak',
    header: 'خطای پیاپی',
    align: 'end',
    render: (row) => formatNumber(row.failureStreak ?? 0),
  },
  { key: 'latency', header: 'تأخیر', align: 'end', render: (row) => (row.latencyMs === undefined || row.latencyMs === null ? '—' : `${formatNumber(row.latencyMs)} ms`) },
];

const SYNC_TYPE_LABELS: Record<string, string> = {
  push_inventory: 'ارسال موجودی',
  push_price: 'ارسال قیمت',
  pull_orders: 'دریافت سفارش',
  product_import: 'ورود محصولات',
  full_reconcile: 'مغایرت‌گیری',
  settlement_pull: 'دریافت تسویه',
  inventory_push: 'ارسال موجودی',
  price_push: 'ارسال قیمت',
  order_pull: 'دریافت سفارش',
};

const jobColumns: readonly Column<SyncJob>[] = [
  {
      key: 'type',
      header: 'نوع',
      render: (job) => (
        <Badge tone="info">{SYNC_TYPE_LABELS[job.jobType ?? job.type] ?? job.type}</Badge>
      ),
    },
  { key: 'channel', header: 'کانال', render: (job) => job.channel?.nameFa ?? job.channel?.name ?? '—' },
  {
    key: 'status',
    header: 'وضعیت',
    render: (job) => <StatusBadge status={job.status} />,
  },
  {
    key: 'progress',
    header: 'پیشرفت',
    render: (job) => {
      const summary = job.summary ?? {};
      const pick = (keys: readonly string[]): string | null => {
        for (const key of keys) {
          const value = summary[key];
          if (typeof value === 'number') return `${key}: ${formatNumber(value)}`;
        }
        return null;
      };
      const parts = [
        pick(['received', 'imported', 'pushed', 'processed']),
        pick(['updated']),
        pick(['duplicates', 'skipped']),
        pick(['failed', 'errors']),
      ].filter((value): value is string => value !== null);
      if (parts.length > 0) return <span className="text-xs">{parts.join(' · ')}</span>;
      if (job.progress !== undefined) {
        return `${formatNumber(job.progress.processed ?? 0)} / ${formatNumber(job.progress.total ?? 0)}`;
      }
      return job.status === 'running' || job.status === 'queued' ? 'در حال اجرا…' : '—';
    },
  },
  {
    key: 'details',
    header: 'توضیحات',
    render: (job) => {
      if (job.lastError !== undefined && job.lastError !== null && job.lastError.length > 0) {
        return <span className="text-xs text-red-600 dark:text-red-400">{job.lastError}</span>;
      }
      const summary = job.summary ?? {};
      const text = Object.entries(summary)
        .filter(([key, value]) => key !== 'jobId' && (typeof value === 'string' || typeof value === 'number'))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' · ');
      return <span className="text-xs text-slate-500">{text.length > 0 ? text : '—'}</span>;
    },
  },
  {
    key: 'createdAt',
    header: 'زمان',
    render: (job) => (job.createdAt === undefined ? '—' : formatJalaliDateTime(job.createdAt)),
  },
];

/** Channel accounts, sync jobs and integration health. */
export function ChannelsPage() {
  useDocumentTitle('یکپارچه‌سازی‌ها');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasPermission(PERM.channelRead);
  const canSync = useHasPermission(PERM.syncTrigger);
  const canTest = useHasPermission(PERM.accountTest);
  const canWriteCredentials = useHasPermission(PERM.credentialWrite);
  const [tab, setTab] = useState('health');
  const [reveal, setReveal] = useState<{ name: string; values: Record<string, string> } | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState('');
  const [syncOpen, setSyncOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountName, setAccountName] = useState('');
  const [externalAccountId, setExternalAccountId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [syncType, setSyncType] = useState('inventory_push');
  const [rsaAccount, setRsaAccount] = useState<ChannelAccount | null>(null);
  const [rsaPublicKey, setRsaPublicKey] = useState('');
  const [rsaPublicKeyPkcs1, setRsaPublicKeyPkcs1] = useState('');
  const [rsaPublicKeyBase64, setRsaPublicKeyBase64] = useState('');
  const [rsaFingerprint, setRsaFingerprint] = useState('');
  const [rsaHasPrivateKey, setRsaHasPrivateKey] = useState(false);
  const [rsaPrivateKeyInput, setRsaPrivateKeyInput] = useState('');
  const [rsaImportOpen, setRsaImportOpen] = useState(false);
  const [rsaBusy, setRsaBusy] = useState(false);
  const [rsaLoading, setRsaLoading] = useState(false);
  const [rsaError, setRsaError] = useState('');
  const [rsaResetNotice, setRsaResetNotice] = useState('');
  const [rsaResetArmed, setRsaResetArmed] = useState(false);
  const [rsaKeyBits, setRsaKeyBits] = useState<2048 | 4096>(4096);
  const [rsaCompareInput, setRsaCompareInput] = useState('');
  const [rsaCompareBusy, setRsaCompareBusy] = useState(false);
  const [rsaCompareResult, setRsaCompareResult] = useState<RsaKeyCompareResult | null>(null);
  const [rsaCompareError, setRsaCompareError] = useState('');
  const [dkClientCode, setDkClientCode] = useState('');
  const [dkUserAgent, setDkUserAgent] = useState('');
  const [dkUaBusy, setDkUaBusy] = useState(false);
  const [dkClientBusy, setDkClientBusy] = useState(false);
  const [dkClientSecret, setDkClientSecret] = useState('');
  const [dkValidationCode, setDkValidationCode] = useState('');
  const [dkBusy, setDkBusy] = useState(false);
  const [dkResult, setDkResult] = useState('');
  const [dkDiag, setDkDiag] = useState('');
  const [dkDiagBusy, setDkDiagBusy] = useState(false);
  const [rsaVerifyBusy, setRsaVerifyBusy] = useState(false);
  const [rsaVerifyResult, setRsaVerifyResult] = useState('');
  const [rsaFormat, setRsaFormat] = useState<'spki' | 'pkcs1' | 'base64'>('spki');

  const channelsQuery = useQuery({
    queryKey: queryKeys.channels.list,
    queryFn: () => api.get<readonly Channel[]>('/channels', { perPage: 100 }),
    enabled: canRead,
    staleTime: 5 * 60_000,
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.channels.health,
    queryFn: () => api.get<readonly ChannelHealthRow[]>('/channels/health'),
    enabled: canRead && tab === 'health',
  });
  const accountsQuery = useQuery({
    queryKey: queryKeys.channels.accounts(selectedChannelId),
    queryFn: () => api.get<readonly ChannelAccount[]>(`/channels/${selectedChannelId}/accounts`, { perPage: 100 }),
    enabled: canRead && tab === 'accounts' && selectedChannelId !== '',
  });
  const jobsQuery = useQuery({
    queryKey: queryKeys.channels.syncJobs({ tab }),
    queryFn: () => api.getPage<SyncJob>('/channel-sync-jobs', { limit: 25 }),
    enabled: canRead && tab === 'jobs',
    // Live view: the sync page must update itself without a manual refresh.
    refetchInterval: tab === 'jobs' ? 4000 : false,
    refetchIntervalInBackground: true,
  });

  const channels = channelsQuery.data ?? [];
  const channelOptions = channels.map((channel) => ({
    value: channel.id,
    label: channel.nameFa ?? channel.name ?? channel.code,
  }));

  const triggerSyncMutation = useMutation({
    mutationFn: () =>
      api.post<SyncJob>(
        '/channel-sync-jobs',
        { channelId: selectedChannelId, type: syncType },
        { idempotencyKey: newRequestId() },
      ),
    onSuccess: () => {
      toast.success('همگام‌سازی در صف قرار گرفت', 'نتیجه در فهرست کارهای همگام‌سازی قابل پیگیری است.');
      setSyncOpen(false);
      void queryClient.invalidateQueries();
    },
    onError: (error) => {
      if (isNotImplemented(error)) {
        toast.info('در حال توسعه', 'این نوع همگام‌سازی هنوز فعال نشده است.');
      } else {
        toast.error('شروع همگام‌سازی ناموفق بود', toFaErrorMessage(error));
      }
    },
  });

  const retryMutation = useMutation({
    mutationFn: (jobId: string) => api.post<SyncJob>(`/channel-sync-jobs/${jobId}/retry`, {}),
    onSuccess: () => {
      toast.success('تلاش مجدد در صف قرار گرفت');
      void queryClient.invalidateQueries({ queryKey: ['channel-sync-jobs'] });
    },
    onError: (error) => toast.error('تلاش مجدد ناموفق بود', toFaErrorMessage(error)),
  });

  const createAccountMutation = useMutation({
    mutationFn: () => {
      const credentials: Record<string, string> = {};
      if (apiKey.trim().length > 0) credentials['api_key'] = apiKey.trim();
      if (apiSecret.trim().length > 0) credentials['api_secret'] = apiSecret.trim();
      if (webhookSecret.trim().length > 0) credentials['webhook_secret'] = webhookSecret.trim();
      return api.post<{ id: string; credentialsStored: readonly string[] }>(
        `/channels/${selectedChannelId}/accounts`,
        {
          name: accountName.trim(),
          externalAccountId: externalAccountId.trim() || undefined,
          credentials,
        },
        { idempotencyKey: newRequestId() },
      );
    },
    onSuccess: (result) => {
      toast.success('حساب کانال ساخته شد', `کلیدهای ذخیره‌شده: ${result.credentialsStored.join('، ') || 'بدون کلید'}`);
      setAccountOpen(false);
      setAccountName('');
      setExternalAccountId('');
      setApiKey('');
      setApiSecret('');
      setWebhookSecret('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels.accounts(selectedChannelId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels.list });
    },
    onError: (error) => toast.error('ساخت حساب ناموفق بود', toFaErrorMessage(error)),
  });

  const testAccountMutation = useMutation({
    mutationFn: (accountId: string) =>
      api.post<{ ok?: boolean; latencyMs?: number }>(`/channel-accounts/${accountId}/test`, {}),
    onSuccess: (result) => {
      if (result.ok === false) {
        toast.warning('اتصال ناموفق', 'تنظیمات اعتبارنامه کانال را بررسی کنید.');
      } else {
        toast.success(
          'اتصال موفق',
          result.latencyMs === undefined ? undefined : `زمان پاسخ: ${formatNumber(result.latencyMs)} میلی‌ثانیه`,
        );
      }
    },
    onError: (error) => toast.error('آزمایش اتصال ناموفق بود', toFaErrorMessage(error)),
  });

  const verifyRsaCode = async (): Promise<void> => {
    if (rsaAccount === null) return;
    setRsaVerifyBusy(true);
    setRsaVerifyResult('');
    try {
      const result = await api.post<{
        ok: boolean;
        decryption?: string;
        message?: string;
        storedFingerprint?: string | null;
      }>(
        `/channel-accounts/${rsaAccount.id}/rsa-keypair/verify`,
        { validationCode: dkValidationCode },
        { idempotencyKey: newRequestId() },
      );
      const fingerprintNote =
        result.storedFingerprint === undefined || result.storedFingerprint === null
          ? ''
          : ` · اثر انگشت ذخیره‌شده: ${result.storedFingerprint}`;
      setRsaVerifyResult(
        result.ok
          ? `رمزگشایی موفق بود (${result.decryption})؛ کلید درست است و می‌توانی توکن بگیری.${fingerprintNote}`
          : `رمزگشایی ناموفق: ${result.message ?? 'کلید با پنل هم‌خوان نیست.'}${fingerprintNote}`,
      );
    } catch (error) {
      setRsaVerifyResult(toFaErrorMessage(error));
    } finally {
      setRsaVerifyBusy(false);
    }
  };

  const activateDigikala = async (): Promise<void> => {
    if (rsaAccount === null) return;
    setDkBusy(true);
    setDkResult('');
    try {
      const result = await api.post<{ ok: boolean; decryption: string; expiresIn?: number | null; hasRefreshToken?: boolean }>(
        `/channel-accounts/${rsaAccount.id}/digikala/token`,
        { validationCode: dkValidationCode, clientCode: dkClientCode, clientSecret: dkClientSecret },
        { idempotencyKey: newRequestId() },
      );
      setDkResult(
        `توکن دریافت شد (${result.decryption}) — ${result.hasRefreshToken ? 'refresh token ذخیره شد' : 'بدون refresh token'}${result.expiresIn ? ` · انقضا ${result.expiresIn} ثانیه` : ''}`,
      );
      toast.success('توکن دیجی‌کالا فعال شد');
      setDkValidationCode('');
    } catch (error) {
      setDkResult(toFaErrorMessage(error));
      toast.error('فعال‌سازی توکن ناموفق بود', toFaErrorMessage(error));
    } finally {
      setDkBusy(false);
    }
  };

  const loadRsaKeypair = async (account: ChannelAccount): Promise<void> => {
    setRsaLoading(true);
    try {
      const view = await api.get<ChannelAccountRsaKeypair>(
        `/channel-accounts/${account.id}/rsa-keypair`,
      );
      setRsaPublicKey(view.publicKeyPem);
      setRsaPublicKeyPkcs1(view.publicKeyPkcs1 ?? '');
      setRsaPublicKeyBase64(view.publicKeyBase64 ?? '');
      setRsaFingerprint(view.fingerprint);
      setRsaHasPrivateKey(view.hasPrivateKey === true);
      if (view.keyBits === 2048 || view.keyBits === 4096) setRsaKeyBits(view.keyBits);
      setRsaError('');
    } catch (error) {
      setRsaPublicKey('');
      setRsaPublicKeyPkcs1('');
      setRsaPublicKeyBase64('');
      setRsaFingerprint('');
      setRsaHasPrivateKey(false);
      setRsaError(error instanceof ApiError && error.code === 'NOT_FOUND' ? '' : toFaErrorMessage(error));
    } finally {
      setRsaLoading(false);
    }
  };

  const openRsaModal = (account: ChannelAccount): void => {
    setRsaAccount(account);
    setRsaPublicKey('');
    setRsaPublicKeyPkcs1('');
    setRsaPublicKeyBase64('');
    setRsaFingerprint('');
    setRsaHasPrivateKey(false);
    setRsaPrivateKeyInput('');
    setRsaImportOpen(false);
    setRsaError('');
    setRsaResetNotice('');
    setRsaResetArmed(false);
    setRsaFormat('spki');
    setRsaKeyBits(4096);
    setRsaCompareInput('');
    setRsaCompareResult(null);
    setRsaCompareError('');
    setDkClientCode('');
    setDkUserAgent(
      rsaAccount && typeof (rsaAccount.settings as Record<string, unknown> | undefined)?.['userAgent'] === 'string'
        ? String((rsaAccount.settings as Record<string, unknown>)['userAgent'])
        : '',
    );
    setDkClientSecret('');
    setDkValidationCode('');
    setDkResult('');
    void loadRsaKeypair(account);
    // Prefill the stored client code/secret so the operator never has to retype
    // them (and browser autofill cannot inject an unrelated username).
    void api
      .get<{ credentials: Record<string, string> }>(`/channel-accounts/${account.id}/credentials/reveal`)
      .then((data) => {
        if (typeof data.credentials.client_code === 'string') setDkClientCode(data.credentials.client_code);
        if (typeof data.credentials.client_secret === 'string') setDkClientSecret(data.credentials.client_secret);
      })
      .catch(() => undefined);
  };

  const saveRsaKeypair = async (privateKeyPem?: string): Promise<void> => {
    if (rsaAccount === null) return;
    setRsaBusy(true);
    setRsaError('');
    try {
      const result = await api.post<ChannelAccountRsaKeypair>(
        `/channel-accounts/${rsaAccount.id}/rsa-keypair`,
        privateKeyPem === undefined ? { bits: rsaKeyBits } : { privateKeyPem },
        { idempotencyKey: newRequestId() },
      );
      setRsaPublicKey(result.publicKeyPem);
      setRsaPublicKeyPkcs1(result.publicKeyPkcs1 ?? '');
      setRsaPublicKeyBase64(result.publicKeyBase64 ?? '');
      setRsaFingerprint(result.fingerprint);
      setRsaHasPrivateKey(true);
      if (result.keyBits === 2048 || result.keyBits === 4096) setRsaKeyBits(result.keyBits);
      setRsaPrivateKeyInput('');
      setRsaImportOpen(false);
      setRsaResetNotice('');
      toast.success('کلید RSA ذخیره شد', 'کلید عمومی را در پنل دیجی‌کالا ثبت کنید.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels.accounts(selectedChannelId) });
    } catch (error) {
      const message = toFaErrorMessage(error);
      setRsaError(message);
      toast.error('ثبت کلید RSA ناموفق بود', message);
    } finally {
      setRsaBusy(false);
    }
  };

  const resetRsaKeypair = async (): Promise<void> => {
    if (rsaAccount === null) return;
    setRsaBusy(true);
    setRsaError('');
    setRsaResetNotice('');
    setRsaResetArmed(false);
    try {
      const result = await api.post<ChannelAccountRsaKeypair>(
        `/channel-accounts/${rsaAccount.id}/rsa-keypair/reset`,
        {},
        { idempotencyKey: newRequestId() },
      );
      setRsaPublicKey(result.publicKeyPem);
      setRsaPublicKeyPkcs1(result.publicKeyPkcs1 ?? '');
      setRsaPublicKeyBase64(result.publicKeyBase64 ?? '');
      setRsaFingerprint(result.fingerprint);
      setRsaHasPrivateKey(result.hasPrivateKey !== false);
      if (result.keyBits === 2048 || result.keyBits === 4096) setRsaKeyBits(result.keyBits);
      setDkValidationCode('');
      setDkResult('');
      setRsaCompareResult(null);
      setRsaCompareInput('');
      setRsaResetNotice(
        'جفت‌کلید جدید ساخته شد. کلید عمومی جدید در کادر بالا قرار گرفت؛ آن را کامل در پنل دیجی‌کالا ثبت کنید و سپس یک کد اعتبارسنجی تازه بگیرید. کدهای قبلی با کلید قدیمی رمز شده‌اند و کار نمی‌کنند.',
      );
      toast.success('جفت‌کلید جدید ساخته شد', 'کلید عمومی جدید را در دیجی‌کالا ثبت کنید و کد تازه بگیرید.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.channels.accounts(selectedChannelId) });
    } catch (error) {
      const message = toFaErrorMessage(error);
      setRsaError(message);
      toast.error('تولید مجدد جفت‌کلید ناموفق بود', message);
    } finally {
      setRsaBusy(false);
    }
  };

  const rsaFormattedKey =
    rsaFormat === 'spki' ? rsaPublicKey : rsaFormat === 'pkcs1' ? rsaPublicKeyPkcs1 : rsaPublicKeyBase64;
  const rsaFormatLabel = rsaFormat === 'spki' ? 'PEM SPKI' : rsaFormat === 'pkcs1' ? 'PEM PKCS#1' : 'Base64 DER';

  const copyPublicKey = async (): Promise<void> => {
    const value = rsaFormattedKey.length > 0 ? rsaFormattedKey : rsaPublicKey;
    if (value.length === 0) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success('کلید عمومی کپی شد');
    } catch {
      setRsaError('کپی خودکار ممکن نشد؛ متن کلید را دستی انتخاب و کپی کنید.');
    }
  };

  const compareRsaKey = async (): Promise<void> => {
    if (rsaAccount === null || rsaCompareInput.trim().length === 0) return;
    setRsaCompareBusy(true);
    setRsaCompareResult(null);
    setRsaCompareError('');
    try {
      const result = await api.post<RsaKeyCompareResult>(
        `/channel-accounts/${rsaAccount.id}/rsa-keypair/compare`,
        { publicKey: rsaCompareInput },
        { idempotencyKey: newRequestId() },
      );
      setRsaCompareResult(result);
    } catch (error) {
      setRsaCompareError(toFaErrorMessage(error));
    } finally {
      setRsaCompareBusy(false);
    }
  };

  const readPrivateKeyFile = async (file: File): Promise<void> => {
    try {
      setRsaPrivateKeyInput(await file.text());
      setRsaError('');
    } catch {
      setRsaError('خواندن فایل کلید ناموفق بود.');
    }
  };

  const accountColumns: readonly Column<ChannelAccount>[] = [
    { key: 'name', header: 'حساب', render: (account) => account.nameFa ?? account.name ?? '—' },
    { key: 'external', header: 'شناسه فروشنده', render: (account) => <span dir="ltr">{account.externalSellerId ?? '—'}</span> },
    {
      key: 'active',
      header: 'وضعیت',
      render: (account) => (
        <Badge tone={account.active === false ? 'neutral' : 'success'}>
          {account.active === false ? 'غیرفعال' : 'فعال'}
        </Badge>
      ),
    },
    {
      key: 'credential',
      header: 'اعتبارنامه',
      render: (account) =>
        account.credentialMeta === undefined
          ? '—'
          : `••••${account.credentialMeta.last4 ?? ''}`,
    },
    {
      key: 'actions',
      header: 'عملیات',
      render: (account) => (
        <div className="flex flex-wrap gap-2">
          {canWriteCredentials ? (
            <Button
              size="sm"
              variant="outline"
              icon={<KeyRound className="size-3.5" />}
              onClick={() => openRsaModal(account)}
            >
              کلید RSA
            </Button>
          ) : null}
          {canTest ? (
            <Button
              size="sm"
              variant="outline"
              icon={<FlaskConical className="size-3.5" />}
              loading={testAccountMutation.isPending}
              onClick={() => testAccountMutation.mutate(account.id)}
            >
              آزمایش اتصال
            </Button>
          ) : null}
          {canWriteCredentials ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void api
                  .get<{ credentials: Record<string, string> }>(`/channel-accounts/${account.id}/credentials/reveal`)
                  .then((data) => setReveal({ name: account.name ?? account.id, values: data.credentials }))
                  .catch((error) => toast.error('نمایش اعتبارنامه ناموفق بود', toFaErrorMessage(error)));
              }}
            >
              نمایش اعتبارنامه
            </Button>
          ) : null}
          {canWriteCredentials ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const name = window.prompt('نام جدید حساب', account.name);
                if (name === null || name.trim().length < 2) return;
                void api
                  .put(`/channel-accounts/${account.id}`, { name: name.trim() })
                  .then(() => {
                    toast.success('حساب ویرایش شد');
                    void queryClient.invalidateQueries({ queryKey: ['channels'] });
                  })
                  .catch((error) => toast.error('ویرایش ناموفق بود', toFaErrorMessage(error)));
              }}
            >
              ویرایش
            </Button>
          ) : null}
          {canWriteCredentials ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (!window.confirm(`حساب «${account.name}» حذف شود؟`)) return;
                void api
                  .del(`/channel-accounts/${account.id}`)
                  .then(() => {
                    toast.success('حساب حذف شد');
                    void queryClient.invalidateQueries({ queryKey: ['channels'] });
                  })
                  .catch((error) => toast.error('حذف ناموفق بود', toFaErrorMessage(error)));
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
        <PageHeader title="یکپارچه‌سازی‌ها" />
        <PermissionNotice permission={PERM.channelRead} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="یکپارچه‌سازی‌ها"
        description="کانال‌های فروش، حساب‌های فروشنده، همگام‌سازی و وضعیت سلامت"
        actions={
          canSync ? (
            <Button icon={<RotateCw className="size-4" />} onClick={() => setSyncOpen(true)} disabled={channels.length === 0}>
              اجرای همگام‌سازی
            </Button>
          ) : undefined
        }
      />

      <Tabs
        ariaLabel="بخش‌های یکپارچه‌سازی"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'health', label: 'سلامت کانال‌ها' },
          { value: 'accounts', label: 'کانال‌ها و حساب‌ها' },
          { value: 'jobs', label: 'کارهای همگام‌سازی' },
        ]}
      />

      <TabPanel value={tab}>
        {tab === 'health' && (
          <>
            {healthQuery.isError ? (
              <ErrorState error={healthQuery.error} onRetry={() => void healthQuery.refetch()} />
            ) : (
              <DataTable
                columns={healthColumns}
                rows={healthQuery.data ?? []}
                rowKey={(row) => row.id ?? `${row.channel?.id ?? ''}-${row.account?.id ?? ''}`}
                loading={healthQuery.isLoading}
                caption="سلامت کانال‌ها"
                emptyTitle="کانالی تنظیم نشده است"
                emptyDescription="برای اتصال به کانال‌های فروش، ابتدا یک کانال را فعال کنید."
              />
            )}
          </>
        )}

        {tab === 'accounts' && (
          <Card>
            <CardHeader title="حساب‌های فروشنده" description="اعتبارنامه‌ها هرگز به‌صورت متن کامل نمایش داده نمی‌شوند." />
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-slate-500">کلیدهای دیجی‌کالا / کِرَکسی اینجا ذخیره و رمزنگاری می‌شوند.</span>
              <Button size="sm" disabled={selectedChannelId === ''} onClick={() => setAccountOpen(true)}>
                افزودن حساب و کلیدها
              </Button>
            </div>
            <div className="mb-3 max-w-sm">
              <Combobox
                options={channelOptions}
                value={selectedChannelId}
                loading={channelsQuery.isLoading}
                placeholder="انتخاب کانال"
                ariaLabel="انتخاب کانال"
                onChange={(value) => setSelectedChannelId(value)}
              />
            </div>
            {selectedChannelId === '' ? (
              <EmptyState
                icon={<PlugZap className="size-8" />}
                title="کانالی انتخاب نشده است"
                description="برای مشاهده حساب‌های فروشنده، یک کانال انتخاب کنید."
              />
            ) : accountsQuery.isError ? (
              <ErrorState error={accountsQuery.error} onRetry={() => void accountsQuery.refetch()} />
            ) : (
              <DataTable
                columns={accountColumns}
                rows={accountsQuery.data ?? []}
                rowKey={(account) => account.id}
                loading={accountsQuery.isLoading}
                caption="حساب‌های کانال"
                emptyTitle="حسابی برای این کانال ثبت نشده است"
              />
            )}
          </Card>
        )}

        {tab === 'jobs' && (
          <>
            {jobsQuery.isError ? (
              <ErrorState error={jobsQuery.error} onRetry={() => void jobsQuery.refetch()} />
            ) : (
              <DataTable
                columns={[
                  ...jobColumns,
                  {
                    key: 'actions',
                    header: 'عملیات',
                    render: (job) =>
                      job.status === 'failed' || job.status === 'partial' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          loading={retryMutation.isPending}
                          onClick={() => retryMutation.mutate(job.id)}
                        >
                          تلاش مجدد
                        </Button>
                      ) : null,
                  },
                ]}
                rows={jobsQuery.data?.items ?? []}
                rowKey={(job) => job.id}
                loading={jobsQuery.isLoading}
                caption="کارهای همگام‌سازی"
                emptyTitle="کاری ثبت نشده است"
                emptyDescription="پس از اجرای همگام‌سازی، وضعیت کارها در این بخش قابل پیگیری است."
              />
            )}
            <p className="mt-2 flex items-center gap-1 text-[11px] text-slate-400">
              <RefreshCw aria-hidden className="size-3.5" />
              همگام‌سازی‌ها به‌صورت غیرهم‌زمان در پس‌زمینه اجرا می‌شوند.
            </p>
          </>
        )}
      </TabPanel>

      <Modal
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        title="افزودن حساب کانال"
        footer={
          <>
            <Button variant="outline" onClick={() => setAccountOpen(false)}>
              انصراف
            </Button>
            <Button
              loading={createAccountMutation.isPending}
              disabled={accountName.trim().length === 0}
              onClick={() => createAccountMutation.mutate()}
            >
              ذخیره حساب
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField label="نام حساب" required>
            <Input value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="مثلاً فروشگاه دیجی‌کالا" />
          </FormField>
          <FormField label="شناسه فروشنده / Seller ID">
            <Input dir="ltr" value={externalAccountId} onChange={(event) => setExternalAccountId(event.target.value)} />
          </FormField>
          <FormField label="API Key">
            <Input dir="ltr" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </FormField>
          <FormField label="API Secret">
            <Input dir="ltr" type="password" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} />
          </FormField>
          <FormField label="Webhook Secret (اختیاری)">
            <Input dir="ltr" type="password" value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} />
          </FormField>
        </div>
      </Modal>

      <Modal
        open={rsaAccount !== null}
        onClose={() => setRsaAccount(null)}
        title="کلید RSA دیجی‌کالا"
        description={
          rsaAccount === null
            ? undefined
            : `حساب: ${rsaAccount.nameFa ?? rsaAccount.name ?? rsaAccount.id}`
        }
        footer={
          <Button variant="outline" onClick={() => setRsaAccount(null)}>
            بستن
          </Button>
        }
      >
        <div className="space-y-4">
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
            کلید عمومی (PEM) را در پنل دیجی‌کالا، بخش احراز هویت فروشنده، جای‌گذاری کنید. کلید
            خصوصی فقط به‌صورت رمزنگاری‌شده در سرور نگهداری می‌شود و هرگز نمایش داده نمی‌شود.
          </p>

          <FormField
            label="اندازهٔ کلید"
            hint="۴۰۹۶ بیت پیشنهادی است؛ ۲۰۴۸ فقط اگر پنل دیجی‌کالا اندازهٔ بزرگ‌تر را نپذیرد."
          >
            <Select
              value={String(rsaKeyBits)}
              disabled={rsaBusy || rsaLoading}
              options={[
                { value: '4096', label: '۴۰۹۶ بیت (پیشنهادی)' },
                { value: '2048', label: '۲۰۴۸ بیت' },
              ]}
              onChange={(event) => setRsaKeyBits(event.target.value === '2048' ? 2048 : 4096)}
            />
          </FormField>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={<KeyRound className="size-3.5" />}
              loading={rsaBusy && !rsaImportOpen}
              disabled={rsaBusy || rsaLoading}
              onClick={() => void saveRsaKeypair()}
            >
              تولید جفت‌کلید
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon={<Upload className="size-3.5" />}
              disabled={rsaBusy || rsaLoading}
              onClick={() => setRsaImportOpen((value) => !value)}
            >
              بارگذاری کلید خصوصی
            </Button>
          </div>

          {rsaImportOpen ? (
            <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <FormField
                label="کلید خصوصی (PEM)"
                hint="فایل .pem یا متن PKCS#8 / PKCS#1 رمزنگاری‌نشده را وارد کنید."
              >
                <Textarea
                  dir="ltr"
                  rows={6}
                  className="font-mono text-[11px]"
                  value={rsaPrivateKeyInput}
                  onChange={(event) => setRsaPrivateKeyInput(event.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                />
              </FormField>
              <input
                type="file"
                accept=".pem,.key,.txt,text/plain"
                className="block w-full text-xs text-slate-500 file:me-2 file:rounded-md file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) void readPrivateKeyFile(file);
                }}
              />
              <Button
                size="sm"
                loading={rsaBusy}
                disabled={rsaPrivateKeyInput.trim().length === 0}
                onClick={() => void saveRsaKeypair(rsaPrivateKeyInput)}
              >
                ذخیره کلید خصوصی
              </Button>
            </div>
          ) : null}

          {rsaError.length > 0 ? (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {rsaError}
            </p>
          ) : null}

          {rsaLoading ? (
            <p className="text-xs text-slate-500">در حال خواندن کلید عمومی…</p>
          ) : rsaPublicKey.length > 0 ? (
            <div className="space-y-2">
              <div role="group" aria-label="قالب کلید عمومی" className="flex flex-wrap gap-1.5">
                {([
                  { value: 'spki' as const, label: 'PEM SPKI' },
                  { value: 'pkcs1' as const, label: 'PEM PKCS#1' },
                  { value: 'base64' as const, label: 'Base64 DER' },
                ] as const).map((format) => (
                  <Button
                    key={format.value}
                    size="sm"
                    variant={rsaFormat === format.value ? 'primary' : 'outline'}
                    onClick={() => setRsaFormat(format.value)}
                  >
                    {format.label}
                  </Button>
                ))}
              </div>
              <FormField
                label={`کلید عمومی (${rsaFormatLabel})`}
                hint="هر سه قالب به یک کلید اشاره می‌کنند؛ هر قالبی را که پنل دیجی‌کالا می‌پذیرد کپی کنید."
              >
                <Textarea
                  dir="ltr"
                  readOnly
                  rows={9}
                  className="font-mono text-[11px]"
                  value={rsaFormattedKey.length > 0 ? rsaFormattedKey : rsaPublicKey}
                />
              </FormField>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  icon={<Copy className="size-3.5" />}
                  onClick={() => void copyPublicKey()}
                >
                  کپی کلید ({rsaFormatLabel})
                </Button>
                <Badge tone={rsaHasPrivateKey ? 'success' : 'warning'}>
                  {rsaHasPrivateKey ? 'کلید خصوصی ذخیره شده است' : 'کلید خصوصی ثبت نشده است'}
                </Badge>
                {rsaKeyBits === 2048 || rsaKeyBits === 4096 ? (
                  <Badge tone="info">{formatNumber(rsaKeyBits)} بیت</Badge>
                ) : null}
              </div>
              <p dir="ltr" className="break-all font-mono text-[10px] text-slate-500">
                SHA-256: {rsaFingerprint}
              </p>

              <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <FormField
                  label="مقایسه با کلید پنل"
                  hint="کلید عمومی نمایش‌داده‌شده در پنل دیجی‌کالا را بچسبانید؛ PEM (SPKI یا PKCS#1) و Base64 DER هر دو پذیرفته می‌شوند."
                >
                  <Textarea
                    dir="ltr"
                    rows={4}
                    className="font-mono text-[11px]"
                    value={rsaCompareInput}
                    onChange={(event) => {
                      setRsaCompareInput(event.target.value);
                      setRsaCompareResult(null);
                      setRsaCompareError('');
                    }}
                    placeholder="-----BEGIN PUBLIC KEY-----"
                  />
                </FormField>
                <Button
                  size="sm"
                  variant="outline"
                  loading={rsaCompareBusy}
                  disabled={rsaCompareInput.trim().length === 0}
                  onClick={() => void compareRsaKey()}
                >
                  مقایسه با کلید پنل
                </Button>
                {rsaCompareError.length > 0 ? (
                  <p role="alert" className="text-[11px] text-red-600 dark:text-red-400">
                    {rsaCompareError}
                  </p>
                ) : null}
                {rsaCompareResult === null ? null : (
                  <div className="space-y-1" role="status">
                    <Badge tone={rsaCompareResult.match ? 'success' : 'danger'}>
                      {rsaCompareResult.match
                        ? 'کلید پنل با کلید ذخیره‌شده یکسان است'
                        : 'کلید پنل با کلید ذخیره‌شده هم‌خوان نیست'}
                    </Badge>
                    <p dir="ltr" className="break-all font-mono text-[10px] text-slate-500">
                      stored: {rsaCompareResult.storedFingerprint}
                    </p>
                    <p dir="ltr" className="break-all font-mono text-[10px] text-slate-500">
                      provided: {rsaCompareResult.providedFingerprint}
                    </p>
                  </div>
                )}
              </div>

              <div className="mt-4 space-y-3 rounded-lg border border-dashed border-slate-300 p-3 dark:border-slate-700">
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  فعال‌سازی توکن دیجی‌کالا
                </p>

                <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-6 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-100">
                  <p className="font-semibold">اگر خطای «کد اعتبارسنجی با این کلید خصوصی هم‌خوان نیست» گرفتید</p>
                  <p>
                    دیجی‌کالا کد را با کلید عمومی‌ای رمز می‌کند که در پنل ثبت شده است؛ اثر انگشت کلید
                    ذخیره‌شده باید دقیقاً با کلید ثبت‌شده در پنل یکی باشد. اگر نیست، جفت‌کلید تازه
                    بسازید، کلید عمومی جدید را در پنل ثبت کنید و بعد یک کد اعتبارسنجی تازه بگیرید.
                  </p>
                  <p dir="ltr" className="break-all font-mono text-[10px] opacity-80">
                    SHA-256: {rsaFingerprint.length > 0 ? rsaFingerprint : '—'}
                  </p>
                  <Button
                    size="sm"
                    variant={rsaResetArmed ? 'danger' : 'outline'}
                    icon={<RotateCw className="size-3.5" />}
                    loading={rsaBusy}
                    disabled={rsaLoading}
                    onClick={() => {
                      if (!rsaResetArmed) {
                        setRsaResetArmed(true);
                        return;
                      }
                      void resetRsaKeypair();
                    }}
                  >
                    {rsaResetArmed ? 'تأیید جایگزینی جفت‌کلید' : 'تولید مجدد جفت‌کلید'}
                  </Button>
                  {rsaResetArmed ? (
                    <p className="font-medium">
                      با تأیید، جفت‌کلید فعلی باطل می‌شود. کلید عمومی جدید را در پنل ثبت کنید و کد
                      اعتبارسنجی تازه بگیرید.
                    </p>
                  ) : null}
                  {rsaResetNotice.length === 0 ? null : (
                    <p role="status" className="font-medium">
                      {rsaResetNotice}
                    </p>
                  )}
                </div>

                <p className="text-[11px] text-slate-500">
                  از پنل دیجی‌کالا فقط دو مقدار «کد کلاینت» و «کد اعتبارسنجی» را کپی کن و اینجا بچسبان؛
                  سامانه کد را با کلید خصوصی رمزگشایی و به توکن تبدیل می‌کند.
                </p>
                <FormField
                  label="کد کلاینت (Client code)"
                  hint="دقیقاً همان مقداری که در پنل دیجی‌کالا زیر Application/Client code نمایش داده می‌شود."
                >
                  <div className="flex gap-2">
                    <Input
                      dir="ltr"
                      name="dk-client-code"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Client code"
                      value={dkClientCode}
                      onChange={(event) => setDkClientCode(event.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      loading={dkClientBusy}
                      disabled={rsaAccount === null || dkClientCode.trim().length === 0}
                      onClick={() => {
                        if (rsaAccount === null) return;
                        setDkClientBusy(true);
                        void api
                          .put(`/channel-accounts/${rsaAccount.id}/credentials`, {
                            credentials: {
                              client_code: dkClientCode.trim(),
                              ...(dkClientSecret.trim().length === 0
                                ? {}
                                : { client_secret: dkClientSecret.trim() }),
                            },
                          })
                          .then(() => toast.success('کد کلاینت ذخیره شد'))
                          .catch((error) => toast.error('ذخیره کد کلاینت ناموفق بود', toFaErrorMessage(error)))
                          .finally(() => setDkClientBusy(false));
                      }}
                    >
                      ذخیره
                    </Button>
                  </div>
                </FormField>
                <FormField
                  label="User-Agent ثبت‌شده در پنل دیجی‌کالا"
                  hint="همان مقداری که هنگام ساخت Client در پنل ثبت کرده‌اید؛ برای تست اتصال و APIها استفاده می‌شود."
                >
                  <div className="flex gap-2">
                    <Input
                      dir="ltr"
                      name="dk-user-agent"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="مثلاً saman-erp یا آدرس دامنه"
                      value={dkUserAgent}
                      onChange={(event) => setDkUserAgent(event.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      loading={dkUaBusy}
                      disabled={rsaAccount === null}
                      onClick={() => {
                        if (rsaAccount === null) return;
                        setDkUaBusy(true);
                        void api
                          .put(`/channel-accounts/${rsaAccount.id}`, {
                            settings: { userAgent: dkUserAgent.trim() },
                          })
                          .then(() => toast.success('User-Agent ذخیره شد', 'حالا «آزمایش اتصال» را بزن.'))
                          .catch((error) => toast.error('ذخیره User-Agent ناموفق بود', toFaErrorMessage(error)))
                          .finally(() => setDkUaBusy(false));
                      }}
                    >
                      ذخیره
                    </Button>
                  </div>
                </FormField>
                <FormField
                  label="کد اعتبارسنجی (Validation code)"
                  hint="مقدار base64؛ یک‌بارمصرف و کوتاه‌عمر است."
                >
                  <Textarea
                    dir="ltr"
                    rows={4}
                    name="dk-validation-code"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Validation code (base64)"
                    className="font-mono text-[11px]"
                    value={dkValidationCode}
                    onChange={(event) => setDkValidationCode(event.target.value)}
                  />
                </FormField>

                <details className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
                  <summary className="cursor-pointer select-none text-[11px] font-medium text-slate-600 dark:text-slate-300">
                    پیشرفته (اختیاری): Client secret
                  </summary>
                  <div className="mt-2 space-y-2">
                    <p className="text-[11px] text-slate-500">
                      سرویس‌هاب دیجی‌کالا معمولاً فقط «کد کلاینت» و «کد اعتبارسنجی» می‌دهد. این فیلد را
                      فقط در صورتی پر کنید که client secret را جداگانه دریافت کرده‌اید.
                    </p>
                    <Input
                      dir="ltr"
                      type="password"
                      placeholder="Client secret (اختیاری)"
                      value={dkClientSecret}
                      onChange={(event) => setDkClientSecret(event.target.value)}
                    />
                  </div>
                </details>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    loading={rsaVerifyBusy}
                    disabled={dkValidationCode.trim().length === 0 || !rsaHasPrivateKey}
                    onClick={() => void verifyRsaCode()}
                  >
                    تست رمزگشایی
                  </Button>
                  <Button
                    size="sm"
                    loading={dkBusy}
                    disabled={dkValidationCode.trim().length === 0 || !rsaHasPrivateKey}
                    onClick={() => void activateDigikala()}
                  >
                    تبدیل کد به توکن
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    loading={dkDiagBusy}
                    disabled={rsaAccount === null}
                    onClick={() => {
                      if (rsaAccount === null) return;
                      setDkDiagBusy(true);
                      setDkDiag('');
                      void api
                        .post<{
                          ok: boolean;
                          winner?: { path: string; attempt: string };
                          clientCodeLength?: number;
                          tokenInfo?: Record<string, unknown>;
                          results: readonly Record<string, unknown>[];
                        }>(`/channel-accounts/${rsaAccount.id}/digikala/diagnose`, {}, { idempotencyKey: newRequestId() })
                        .then((data) => {
                          const lines = data.results.map((row) =>
                            [row['step'] ?? row['path'], row['attempt'] ?? row['auth'], row['ua'], row['status'], row['body'] ?? row['error'] ?? '']
                              .filter((part) => part !== undefined && part !== null && part !== '')
                              .join(' | '),
                          );
                          setDkDiag(
                            'tokenInfo=' + JSON.stringify(data.tokenInfo ?? {}) + '\n' +
                            (data.ok ? 'موفق: ' + JSON.stringify(data.winner) : 'هیچ ترکیبی موفق نبود') +
                              ' (client_code len=' +
                              String(data.clientCodeLength ?? '?') +
                              ')\n' +
                              lines.join('\n'),
                          );
                        })
                        .catch((error) => setDkDiag(toFaErrorMessage(error)))
                        .finally(() => setDkDiagBusy(false));
                    }}
                  >
                    تشخیص عمیق اتصال
                  </Button>
                </div>
                {rsaVerifyResult === '' ? null : (
                  <p className="text-[11px] text-slate-600 dark:text-slate-300">{rsaVerifyResult}</p>
                )}
                {dkResult === '' ? null : <p className="text-[11px] text-slate-600 dark:text-slate-300">{dkResult}</p>}
                {dkDiag === '' ? null : (
                  <pre dir="ltr" className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-100 p-2 text-[10px] leading-5 dark:bg-slate-900">
                    {dkDiag}
                  </pre>
                )}
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              هنوز کلید RSA برای این حساب ثبت نشده است؛ جفت‌کلید بسازید یا کلید خصوصی موجود را
              بارگذاری کنید.
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={syncOpen}
        onClose={() => setSyncOpen(false)}
        title="اجرای همگام‌سازی"
        footer={
          <>
            <Button variant="outline" onClick={() => setSyncOpen(false)}>
              انصراف
            </Button>
            <Button
              loading={triggerSyncMutation.isPending}
              disabled={selectedChannelId === ''}
              onClick={() => triggerSyncMutation.mutate()}
            >
              اجرا
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField label="کانال" required>
            <Select
              options={channelOptions}
              placeholder="انتخاب کانال"
              value={selectedChannelId}
              onChange={(event) => setSelectedChannelId(event.target.value)}
            />
          </FormField>
          <FormField label="نوع همگام‌سازی" required>
            <Select options={SYNC_TYPES} value={syncType} onChange={(event) => setSyncType(event.target.value)} />
          </FormField>
        </div>
      </Modal>

      <Modal
        open={reveal !== null}
        onClose={() => setReveal(null)}
        title={`اعتبارنامهٔ ${reveal?.name ?? ''}`}
        size="md"
      >
        <div className="space-y-2">
          <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            این مقادیر محرمانه‌اند؛ پس از استفاده پنجره را ببند.
          </p>
          {Object.entries(reveal?.values ?? {}).map(([key, value]) => (
            <div key={key} className="rounded-lg border border-slate-200 p-2 dark:border-slate-700">
              <div className="text-xs text-slate-500">{key}</div>
              <div dir="ltr" className="select-all break-all font-mono text-xs">{value}</div>
            </div>
          ))}
          {Object.keys(reveal?.values ?? {}).length === 0 && (
            <p className="text-sm text-slate-500">اعتبارنامه‌ای ثبت نشده است.</p>
          )}
        </div>
      </Modal>
    </>
  );
}
