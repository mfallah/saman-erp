import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { KeyRound, Loader2, LockKeyhole, MessageSquareText, ShieldCheck } from 'lucide-react';
import { api, toFaErrorMessage, ApiError } from '../lib/api-client';
import { APP_NAME_FA } from '../lib/config';
import {
  completeLogin,
  deviceFingerprint,
  fetchAuthConfig,
} from '../lib/auth-store';
import { formatNumber } from '../lib/money';
import { useDocumentTitle } from '../lib/hooks';
import { queryKeys } from '../lib/query-keys';
import { useSearchParam } from '../lib/router';
import type { LoginResult, OtpChallengeResult } from '../types/api';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { Tabs } from '../components/ui/Tabs';
import { useToast } from '../components/ui/Toast';

const passwordSchema = z.object({
  username: z.string().trim().min(3, 'شناسه کاربری یا شماره موبایل را وارد کنید.'),
  password: z.string().min(1, 'رمز عبور را وارد کنید.'),
  rememberDevice: z.boolean().optional(),
});
type PasswordForm = z.infer<typeof passwordSchema>;

const mobileSchema = z.object({
  mobile: z
    .string()
    .trim()
    .regex(/^09\d{9}$/, 'شماره موبایل باید با ۰۹ شروع شود و ۱۱ رقم باشد.'),
  rememberDevice: z.boolean().optional(),
});
type MobileForm = z.infer<typeof mobileSchema>;

const otpSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'کد یکبار مصرف ۶ رقم است.'),
  trustDevice: z.boolean().optional(),
});
type OtpForm = z.infer<typeof otpSchema>;

interface ChallengeState {
  readonly challengeId: string;
  readonly kind: 'login_otp' | 'mfa';
  readonly mobile: string;
  readonly resendAfter: number;
  readonly expiresIn: number;
}

function useCountdown(initialSeconds: number): { remaining: number; restart: (seconds: number) => void } {
  const [remaining, setRemaining] = useState(initialSeconds);
  useEffect(() => {
    if (remaining <= 0) {
      return;
    }
    const timer = window.setTimeout(() => setRemaining((current) => current - 1), 1_000);
    return () => window.clearTimeout(timer);
  }, [remaining]);
  return { remaining, restart: (seconds: number) => setRemaining(Math.max(seconds, 0)) };
}

/** Login screen: password or OTP-first login followed by a 2FA/OTP step. */
export function LoginPage() {
  useDocumentTitle('ورود');
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<'password' | 'otp'>('password');
  const [challenge, setChallenge] = useState<ChallengeState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const resend = useCountdown(challenge?.resendAfter ?? 0);

  const configQuery = useQuery({
    queryKey: queryKeys.auth.config,
    queryFn: fetchAuthConfig,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const config = configQuery.data ?? null;
  const searchRedirect = useSearchParam('redirect');
  const redirectTo = useMemo(
    () => (searchRedirect !== undefined && searchRedirect.startsWith('/') ? searchRedirect : '/'),
    [searchRedirect],
  );

  const passwordForm = useForm<PasswordForm>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { username: '', password: '', rememberDevice: false },
  });
  const mobileForm = useForm<MobileForm>({
    resolver: zodResolver(mobileSchema),
    defaultValues: { mobile: '', rememberDevice: false },
  });
  const otpForm = useForm<OtpForm>({
    resolver: zodResolver(otpSchema),
    defaultValues: { code: '', trustDevice: false },
  });

  useEffect(() => {
    if (challenge !== null) {
      otpForm.reset();
    }
  }, [challenge, otpForm]);

  const finishLogin = async (result: LoginResult): Promise<void> => {
    if (result.accessToken === undefined) {
      setFormError('پاسخ سرور نامعتبر است؛ لطفاً دوباره تلاش کنید.');
      return;
    }
    await completeLogin(
      { accessToken: result.accessToken, permissionsVersion: result.permissionsVersion },
      result.user,
    );
    toast.success('خوش آمدید', 'ورود با موفقیت انجام شد.');
    router.history.push(redirectTo);
  };

  const passwordMutation = useMutation({
    mutationFn: (values: PasswordForm) =>
      api.post<LoginResult>(
        '/auth/login',
        {
          username: values.username,
          password: values.password,
          deviceFingerprint: deviceFingerprint(),
          deviceName: navigator.userAgent.slice(0, 80),
          rememberDevice: values.rememberDevice === true,
        },
        { skipAuth: true },
      ),
    onSuccess: async (result) => {
      setFormError(null);
      if (result.mfaRequired === true && result.challengeId !== undefined) {
        setChallenge({
          challengeId: result.challengeId,
          kind: 'mfa',
          mobile: passwordForm.getValues('username'),
          resendAfter: result.expiresIn ?? 120,
          expiresIn: result.expiresIn ?? 120,
        });
        resend.restart(result.expiresIn ?? 120);
        otpForm.reset();
        return;
      }
      await finishLogin(result);
    },
    onError: (error) => {
      setFormError(toFaErrorMessage(error));
    },
  });

  const otpLoginMutation = useMutation({
    mutationFn: (values: MobileForm) =>
      api.post<OtpChallengeResult>(
        '/auth/login/otp',
        {
          mobile: values.mobile,
          deviceFingerprint: deviceFingerprint(),
          deviceName: navigator.userAgent.slice(0, 80),
        },
        { skipAuth: true },
      ),
    onSuccess: (result) => {
      setFormError(null);
      if (result.challengeId === undefined) {
        setFormError('دریافت کد یکبار مصرف ناموفق بود.');
        return;
      }
      setChallenge({
        challengeId: result.challengeId,
        kind: 'login_otp',
        mobile: mobileForm.getValues('mobile'),
        resendAfter: result.resendAfter ?? 60,
        expiresIn: result.expiresIn ?? 120,
      });
      resend.restart(result.resendAfter ?? 60);
      otpForm.reset();
    },
    onError: (error) => setFormError(toFaErrorMessage(error)),
  });

  const verifyMutation = useMutation({
    mutationFn: async (values: OtpForm) => {
      if (challenge === null) {
        throw new Error('چالش ورود یافت نشد.');
      }
      const path = challenge.kind === 'mfa' ? '/auth/mfa/verify' : '/auth/otp/verify';
      return api.post<LoginResult>(
        path,
        {
          challengeId: challenge.challengeId,
          code: values.code,
          deviceFingerprint: deviceFingerprint(),
          trustDevice: values.trustDevice === true,
        },
        { skipAuth: true },
      );
    },
    onSuccess: async (result) => {
      setFormError(null);
      await finishLogin(result);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'OTP_ATTEMPTS_EXCEEDED') {
        setChallenge(null);
      }
      setFormError(toFaErrorMessage(error));
    },
  });

  const resendMutation = useMutation({
    mutationFn: async () => {
      if (challenge === null) {
        throw new Error('چالش ورود یافت نشد.');
      }
      if (challenge.kind === 'mfa') {
        return api.post<{ resendAfter?: number }>(
          '/auth/mfa/resend',
          { challengeId: challenge.challengeId },
          { skipAuth: true },
        );
      }
      return api.post<OtpChallengeResult>(
        '/auth/otp/request',
        { purpose: 'login', challengeId: challenge.challengeId, mobile: challenge.mobile },
        { skipAuth: true },
      );
    },
    onSuccess: (result) => {
      const wait = result.resendAfter ?? 60;
      resend.restart(wait);
      toast.info('کد جدید ارسال شد', 'کد یکبار مصرف تازه‌ای برای شما پیامک شد.');
    },
    onError: (error) => setFormError(toFaErrorMessage(error)),
  });

  const orgName = config?.orgName ?? APP_NAME_FA;
  const busy =
    passwordMutation.isPending || otpLoginMutation.isPending || verifyMutation.isPending;

  return (
    <div className="grid min-h-dvh place-items-center bg-gradient-to-bl from-brand-50 via-slate-50 to-white p-4 dark:from-slate-950 dark:via-slate-950 dark:to-slate-900">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="grid size-14 place-items-center rounded-2xl bg-brand-700 text-xl font-bold text-white shadow-lg">
            س
          </span>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{orgName}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            سامانه یکپارچه فروش، انبار و حسابداری
          </p>
        </div>

        <Card className="p-5">
          {challenge === null ? (
            <>
              <Tabs
                ariaLabel="روش ورود"
                items={[
                  { value: 'password', label: 'ورود با رمز عبور', icon: <LockKeyhole className="size-4" /> },
                  { value: 'otp', label: 'ورود با کد یکبار مصرف', icon: <MessageSquareText className="size-4" /> },
                ]}
                value={mode}
                onChange={(value) => {
                  setMode(value === 'otp' ? 'otp' : 'password');
                  setFormError(null);
                }}
                className="mb-5"
              />

              {mode === 'password' ? (
                <form
                  noValidate
                  onSubmit={passwordForm.handleSubmit((values) => passwordMutation.mutate(values))}
                  className="space-y-4"
                >
                  <FormField
                    label="شناسه کاربری یا موبایل"
                    htmlFor="login-username"
                    required
                    {...(passwordForm.formState.errors.username === undefined
                      ? {}
                      : { error: passwordForm.formState.errors.username.message })}
                  >
                    <Input
                      id="login-username"
                      autoComplete="username"
                      dir="ltr"
                      className="text-left"
                      invalid={passwordForm.formState.errors.username !== undefined}
                      {...passwordForm.register('username')}
                    />
                  </FormField>
                  <FormField
                    label="رمز عبور"
                    htmlFor="login-password"
                    required
                    {...(passwordForm.formState.errors.password === undefined
                      ? {}
                      : { error: passwordForm.formState.errors.password.message })}
                  >
                    <Input
                      id="login-password"
                      type="password"
                      autoComplete="current-password"
                      dir="ltr"
                      className="text-left"
                      invalid={passwordForm.formState.errors.password !== undefined}
                      {...passwordForm.register('password')}
                    />
                  </FormField>
                  <Button type="submit" block loading={passwordMutation.isPending} disabled={busy}>
                    ورود به سامانه
                  </Button>
                </form>
              ) : (
                <form
                  noValidate
                  onSubmit={mobileForm.handleSubmit((values) => otpLoginMutation.mutate(values))}
                  className="space-y-4"
                >
                  <FormField
                    label="شماره موبایل"
                    htmlFor="login-mobile"
                    required
                    hint="کد یکبار مصرف به این شماره پیامک می‌شود."
                    {...(mobileForm.formState.errors.mobile === undefined
                      ? {}
                      : { error: mobileForm.formState.errors.mobile.message })}
                  >
                    <Input
                      id="login-mobile"
                      inputMode="numeric"
                      autoComplete="tel"
                      dir="ltr"
                      className="text-left"
                      placeholder="09121234567"
                      invalid={mobileForm.formState.errors.mobile !== undefined}
                      {...mobileForm.register('mobile')}
                    />
                  </FormField>
                  <Button type="submit" block loading={otpLoginMutation.isPending} disabled={busy}>
                    دریافت کد ورود
                  </Button>
                </form>
              )}
            </>
          ) : (
            <form
              noValidate
              onSubmit={otpForm.handleSubmit((values) => verifyMutation.mutate(values))}
              className="space-y-4"
            >
              <div className="flex items-center gap-2 rounded-lg bg-brand-50 p-3 text-sm text-brand-900 dark:bg-brand-950 dark:text-brand-100">
                <ShieldCheck aria-hidden className="size-5 shrink-0" />
                <span>
                  کد ۶ رقمی ارسال‌شده به <span dir="ltr">{challenge.mobile}</span> را وارد کنید.
                </span>
              </div>
              <FormField
                label="کد یکبار مصرف"
                htmlFor="login-otp"
                required
                hint={`اعتبار کد: ${formatNumber(challenge.expiresIn)} ثانیه`}
                {...(otpForm.formState.errors.code === undefined
                  ? {}
                  : { error: otpForm.formState.errors.code.message })}
              >
                <Input
                  id="login-otp"
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  dir="ltr"
                  className="text-center text-lg tracking-[0.4em]"
                  placeholder="––––––"
                  invalid={otpForm.formState.errors.code !== undefined}
                  {...otpForm.register('code')}
                />
              </FormField>
              <Button type="submit" block loading={verifyMutation.isPending}>
                <KeyRound aria-hidden className="size-4" />
                تأیید و ورود
              </Button>
              <div className="flex items-center justify-between gap-2 text-xs">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setChallenge(null);
                    setFormError(null);
                  }}
                >
                  بازگشت
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={resend.remaining > 0 || resendMutation.isPending}
                  loading={resendMutation.isPending}
                  onClick={() => resendMutation.mutate()}
                >
                  {resend.remaining > 0
                    ? `ارسال مجدد تا ${formatNumber(resend.remaining)} ثانیه`
                    : 'ارسال مجدد کد'}
                </Button>
              </div>
            </form>
          )}

          {formError !== null && (
            <p role="alert" className="mt-4 rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
              {formError}
            </p>
          )}

          {configQuery.isError && (
            <p className="mt-4 text-center text-[11px] text-slate-400">
              پیکربندی سرور در دسترس نیست؛ ممکن است برخی گزینه‌های ورود غیرفعال باشند.
            </p>
          )}
        </Card>

        <p className="mt-4 flex items-center justify-center gap-1 text-center text-[11px] text-slate-400">
          <Loader2 aria-hidden className={configQuery.isLoading ? 'size-3 animate-spin' : 'hidden'} />
          دسترسی‌ها بر پایه نقش شما اعمال می‌شود.
        </p>
      </div>
    </div>
  );
}
