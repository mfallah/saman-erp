/**
 * Persian, user-safe Limo error mapping. Provider `Message` text is never shown
 * to end users and never logged verbatim; only a stable code + Persian message.
 */
export type LimoErrorCode =
  | 'CONFIG'
  | 'INVALID_MOBILE'
  | 'INVALID_REQUEST'
  | 'BUDGET_EXHAUSTED'
  | 'BLOCKED_RECIPIENT'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REJECTED';

const MESSAGES: Record<LimoErrorCode, string> = {
  CONFIG: 'تنظیمات سرویس پیامک کامل نیست.',
  INVALID_MOBILE: 'شمارهٔ موبایل معتبر نیست.',
  INVALID_REQUEST: 'درخواست ارسال پیامک معتبر نیست.',
  BUDGET_EXHAUSTED: 'اعتبار روزانهٔ پیامک تکمیل شده است.',
  BLOCKED_RECIPIENT: 'ارسال به این شماره مسدود شده است.',
  RATE_LIMITED: 'تعداد درخواست‌های پیامک بیش از حد مجاز است.',
  PROVIDER_UNAVAILABLE: 'سرویس پیامک در دسترس نیست؛ لطفاً بعداً تلاش کنید.',
  PROVIDER_REJECTED: 'سرویس پیامک درخواست را نپذیرفت.',
};

export class LimoError extends Error {
  readonly code: LimoErrorCode;
  readonly messageFa: string;
  readonly retryable: boolean;
  readonly providerMessage: string | null;

  constructor(
    code: LimoErrorCode,
    options: { retryable?: boolean; providerMessage?: string | null; cause?: unknown } = {},
  ) {
    super(MESSAGES[code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LimoError';
    this.code = code;
    this.messageFa = MESSAGES[code];
    this.retryable = options.retryable ?? (code === 'PROVIDER_UNAVAILABLE' || code === 'RATE_LIMITED');
    this.providerMessage =
      options.providerMessage === undefined || options.providerMessage === null
        ? null
        : options.providerMessage.slice(0, 300);
  }
}

/** Classifies the provider's Persian/English message into a stable code. */
export function mapProviderFailure(message: string | undefined): LimoError {
  const text = (message ?? '').toLowerCase();
  if (/credit|charge|balance|اعتبار|موجودی|شارژ/.test(text)) {
    return new LimoError('BUDGET_EXHAUSTED', { providerMessage: message ?? null });
  }
  if (/block|blacklist|مسدود/.test(text)) {
    return new LimoError('BLOCKED_RECIPIENT', { providerMessage: message ?? null });
  }
  if (/rate|too many|429|محدود/.test(text)) {
    return new LimoError('RATE_LIMITED', { providerMessage: message ?? null, retryable: true });
  }
  if (/mobile|phone|number|شماره|نامعتبر|invalid/.test(text)) {
    return new LimoError('INVALID_MOBILE', { providerMessage: message ?? null });
  }
  return new LimoError('PROVIDER_REJECTED', { providerMessage: message ?? null });
}
