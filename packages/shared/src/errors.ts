/**
 * Stable error registry and `AppError` (`API.md` §1.4.1).
 *
 * Clients branch on `code`, never on `message`. `message` is Persian and safe to
 * display; it must never carry SQL, stack traces, secrets, internal ids or raw
 * partner payloads. HTTP status per code is fixed by the contract.
 */
import type { ZodError } from 'zod';

export interface ErrorDefinition {
  /** HTTP status mandated by the API contract. */
  readonly httpStatus: number;
  /** Default Persian, user-safe message. */
  readonly messageFa: string;
  /** Stable i18n key (`module.rule` style). */
  readonly messageKey: string;
}

export const ERROR_CODES = {
  BAD_REQUEST: {
    httpStatus: 400,
    messageFa: 'درخواست ارسال‌شده معتبر نیست.',
    messageKey: 'error.bad_request',
  },
  VALIDATION_ERROR: {
    httpStatus: 400,
    messageFa: 'داده‌های ورودی معتبر نیستند.',
    messageKey: 'error.validation_error',
  },
  UNAUTHENTICATED: {
    httpStatus: 401,
    messageFa: 'برای انجام این عملیات باید وارد حساب کاربری شوید.',
    messageKey: 'error.unauthenticated',
  },
  TOKEN_EXPIRED: {
    httpStatus: 401,
    messageFa: 'نشست شما منقضی شده است؛ لطفاً دوباره وارد شوید.',
    messageKey: 'error.token_expired',
  },
  MFA_REQUIRED: {
    httpStatus: 401,
    messageFa: 'تأیید دومرحله‌ای برای ادامهٔ ورود لازم است.',
    messageKey: 'error.mfa_required',
  },
  PERMISSIONS_CHANGED: {
    httpStatus: 401,
    messageFa: 'دسترسی‌های شما تغییر کرده است؛ لطفاً صفحه را دوباره بارگذاری کنید.',
    messageKey: 'error.permissions_changed',
  },
  SESSION_REVOKED: {
    httpStatus: 401,
    messageFa: 'نشست شما پایان یافته است؛ لطفاً دوباره وارد شوید.',
    messageKey: 'error.session_revoked',
  },
  REFRESH_TOKEN_REUSED: {
    httpStatus: 401,
    messageFa: 'به دلایل امنیتی همهٔ نشست‌های شما بسته شد؛ دوباره وارد شوید.',
    messageKey: 'error.refresh_token_reused',
  },
  STEP_UP_REQUIRED: {
    httpStatus: 401,
    messageFa: 'برای انجام این عملیات حساس، هویت خود را دوباره تأیید کنید.',
    messageKey: 'error.step_up_required',
  },
  FORBIDDEN: {
    httpStatus: 403,
    messageFa: 'شما اجازهٔ انجام این عملیات را ندارید.',
    messageKey: 'error.forbidden',
  },
  SCOPE_DENIED: {
    httpStatus: 403,
    messageFa: 'این مورد خارج از محدودهٔ دسترسی شماست.',
    messageKey: 'error.scope_denied',
  },
  IP_NOT_ALLOWED: {
    httpStatus: 403,
    messageFa: 'دسترسی از این نشانی شبکه مجاز نیست.',
    messageKey: 'error.ip_not_allowed',
  },
  NOT_FOUND: {
    httpStatus: 404,
    messageFa: 'مورد درخواستی یافت نشد.',
    messageKey: 'error.not_found',
  },
  METHOD_NOT_ALLOWED: {
    httpStatus: 405,
    messageFa: 'این روش درخواست برای این مسیر پشتیبانی نمی‌شود.',
    messageKey: 'error.method_not_allowed',
  },
  CONFLICT: {
    httpStatus: 409,
    messageFa: 'مقداری تکراری است و با داده‌های موجود تعارض دارد.',
    messageKey: 'error.conflict',
  },
  VERSION_CONFLICT: {
    httpStatus: 409,
    messageFa: 'این اطلاعات توسط کاربر دیگری تغییر کرده است؛ صفحه را دوباره بارگذاری کنید.',
    messageKey: 'error.version_conflict',
  },
  APPROVAL_REQUIRED: {
    httpStatus: 409,
    messageFa: 'این عملیات نیازمند تأیید کاربر دیگری است.',
    messageKey: 'error.approval_required',
  },
  APPROVAL_PENDING: {
    httpStatus: 409,
    messageFa: 'برای این سند درخواست تأیید در انتظار بررسی وجود دارد.',
    messageKey: 'error.approval_pending',
  },
  IDEMPOTENCY_IN_PROGRESS: {
    httpStatus: 409,
    messageFa: 'درخواست مشابهی در حال پردازش است؛ کمی بعد دوباره تلاش کنید.',
    messageKey: 'error.idempotency_in_progress',
  },
  IDEMPOTENCY_KEY_REUSED: {
    httpStatus: 409,
    messageFa: 'کلید تکرار برای درخواستی با محتوای متفاوت استفاده شده است.',
    messageKey: 'error.idempotency_key_reused',
  },
  DOCUMENT_STATE_INVALID: {
    httpStatus: 409,
    messageFa: 'وضعیت فعلی سند اجازهٔ این تغییر را نمی‌دهد.',
    messageKey: 'error.document_state_invalid',
  },
  PAYLOAD_TOO_LARGE: {
    httpStatus: 413,
    messageFa: 'حجم دادهٔ ارسالی بیش از حد مجاز است.',
    messageKey: 'error.payload_too_large',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    httpStatus: 415,
    messageFa: 'نوع محتوای ارسالی پشتیبانی نمی‌شود.',
    messageKey: 'error.unsupported_media_type',
  },
  RULE_VIOLATION: {
    httpStatus: 422,
    messageFa: 'قانون کسب‌وکار اجازهٔ این عملیات را نمی‌دهد.',
    messageKey: 'error.rule_violation',
  },
  INSUFFICIENT_STOCK: {
    httpStatus: 422,
    messageFa: 'موجودی کافی برای این اقلام وجود ندارد.',
    messageKey: 'inventory.insufficient_stock',
  },
  PERIOD_CLOSED: {
    httpStatus: 422,
    messageFa: 'دورهٔ مالی مربوطه بسته شده است.',
    messageKey: 'accounting.period_closed',
  },
  FISCAL_YEAR_CLOSED: {
    httpStatus: 422,
    messageFa: 'سال مالی مربوطه بسته شده است.',
    messageKey: 'accounting.fiscal_year_closed',
  },
  JOURNAL_UNBALANCED: {
    httpStatus: 422,
    messageFa: 'جمع بدهکار و بستانکار سند برابر نیست.',
    messageKey: 'accounting.journal_unbalanced',
  },
  COST_CENTER_REQUIRED: {
    httpStatus: 422,
    messageFa: 'ثبت مرکز هزینه برای این حساب الزامی است.',
    messageKey: 'accounting.cost_center_required',
  },
  PRICE_BELOW_MARGIN: {
    httpStatus: 422,
    messageFa: 'قیمت پیشنهادی از حداقل حاشیهٔ سود کمتر است.',
    messageKey: 'pricing.price_below_margin',
  },
  CURRENT_PASSWORD_INVALID: {
    httpStatus: 422,
    messageFa: 'رمز عبور فعلی صحیح نیست.',
    messageKey: 'identity.current_password_invalid',
  },
  PASSWORD_POLICY_VIOLATION: {
    httpStatus: 422,
    messageFa: 'رمز عبور با سیاست امنیتی سازگار نیست.',
    messageKey: 'identity.password_policy_violation',
  },
  OTP_INVALID: {
    httpStatus: 422,
    messageFa: 'کد تأیید واردشده صحیح نیست.',
    messageKey: 'identity.otp_invalid',
  },
  OTP_EXPIRED: {
    httpStatus: 422,
    messageFa: 'کد تأیید منقضی شده است؛ کد جدید درخواست کنید.',
    messageKey: 'identity.otp_expired',
  },
  OTP_ATTEMPTS_EXCEEDED: {
    httpStatus: 422,
    messageFa: 'تعداد تلاش‌های نادرست بیش از حد مجاز است؛ کد جدید درخواست کنید.',
    messageKey: 'identity.otp_attempts_exceeded',
  },
  OTP_RESEND_TOO_SOON: {
    httpStatus: 422,
    messageFa: 'ارسال کد جدید پیش از پایان زمان انتظار ممکن نیست.',
    messageKey: 'identity.otp_resend_too_soon',
  },
  UPLOAD_UNSUPPORTED_TYPE: {
    httpStatus: 422,
    messageFa: 'نوع فایل ارسالی با محتوای آن سازگار نیست.',
    messageKey: 'files.upload_unsupported_type',
  },
  UPLOAD_CHECKSUM_MISMATCH: {
    httpStatus: 422,
    messageFa: 'فایل به‌درستی منتقل نشده است؛ دوباره بارگذاری کنید.',
    messageKey: 'files.upload_checksum_mismatch',
  },
  IMPORT_VALIDATION_FAILED: {
    httpStatus: 422,
    messageFa: 'برخی سطرهای فایل واردشده معتبر نیستند.',
    messageKey: 'import.validation_failed',
  },
  RESOURCE_LOCKED: {
    httpStatus: 423,
    messageFa: 'این سند توسط فرایند یا کاربر دیگری در حال ویرایش است.',
    messageKey: 'error.resource_locked',
  },
  PRECONDITION_REQUIRED: {
    httpStatus: 428,
    messageFa: 'برای این تغییر باید شناسهٔ نسخهٔ فعلی سند ارسال شود.',
    messageKey: 'error.precondition_required',
  },
  RATE_LIMITED: {
    httpStatus: 429,
    messageFa: 'تعداد درخواست‌ها بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید.',
    messageKey: 'error.rate_limited',
  },
  NOT_IMPLEMENTED: {
    httpStatus: 501,
    messageFa: 'این قابلیت هنوز پیاده‌سازی نشده است.',
    messageKey: 'error.not_implemented',
  },
  UPSTREAM_UNAVAILABLE: {
    httpStatus: 502,
    messageFa: 'سرویس خارجی در دسترس نیست؛ دوباره تلاش کنید.',
    messageKey: 'error.upstream_unavailable',
  },
  UPSTREAM_INVALID_RESPONSE: {
    httpStatus: 502,
    messageFa: 'پاسخ سرویس خارجی با قرارداد توافق‌شده سازگار نیست.',
    messageKey: 'error.upstream_invalid_response',
  },
  SERVICE_DEGRADED: {
    httpStatus: 503,
    messageFa: 'سرویس موقتاً با ظرفیت محدود کار می‌کند؛ کمی بعد دوباره تلاش کنید.',
    messageKey: 'error.service_degraded',
  },
  MAINTENANCE_MODE: {
    httpStatus: 503,
    messageFa: 'سامانه در حال به‌روزرسانی است؛ کمی بعد دوباره تلاش کنید.',
    messageKey: 'error.maintenance_mode',
  },
  INTERNAL: {
    httpStatus: 500,
    messageFa: 'خطای داخلی سرور رخ داد؛ لطفاً با شناسهٔ درخواست با پشتیبانی تماس بگیرید.',
    messageKey: 'error.internal',
  },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_CODES;

export type ErrorDetailParam = string | number | boolean | null;

/** Structured, machine-readable error detail (`API.md` §1.4). */
export interface ErrorDetail {
  field?: string;
  rule?: string;
  path?: string | readonly (string | number)[];
  code?: string;
  params?: Record<string, ErrorDetailParam>;
}

/** Safe upstream fault descriptor; never carries the raw partner body. */
export interface UpstreamErrorInfo {
  channel: string;
  httpStatus?: number;
  retryable?: boolean;
}

export interface AppErrorOptions {
  /** Persian, user-safe override; defaults to the registry message. */
  message?: string;
  messageKey?: string;
  details?: readonly ErrorDetail[];
  /** Seconds; only meaningful for `429`/`503`. */
  retryAfter?: number;
  upstream?: UpstreamErrorInfo;
  cause?: unknown;
}

export interface ErrorEnvelopeBody {
  error: {
    code: ErrorCode;
    message: string;
    messageKey: string;
    details?: readonly ErrorDetail[];
    requestId: string;
    retryAfter?: number;
    upstream?: UpstreamErrorInfo;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly messageFa: string;
  readonly messageKey: string;
  readonly details?: readonly ErrorDetail[];
  readonly retryAfter?: number;
  readonly upstream?: UpstreamErrorInfo;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const definition = ERROR_CODES[code];
    const message = options.message ?? definition.messageFa;
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = definition.httpStatus;
    this.messageFa = message;
    this.messageKey = options.messageKey ?? definition.messageKey;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
    this.upstream = options.upstream;
  }

  /** Serializes to the `{ error: {...} }` envelope of `API.md` §1.4. */
  toEnvelope(requestId: string): ErrorEnvelopeBody {
    return {
      error: {
        code: this.code,
        message: this.messageFa,
        messageKey: this.messageKey,
        ...(this.details !== undefined && this.details.length > 0 ? { details: this.details } : {}),
        requestId,
        ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}),
        ...(this.upstream !== undefined ? { upstream: this.upstream } : {}),
      },
    };
  }
}

/** Narrows an unknown thrown value to `AppError` without a class-hierarchy leak. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Maps a Zod validation failure to `VALIDATION_ERROR` with contract details. */
export function appErrorFromZod(error: ZodError): AppError {
  const details: ErrorDetail[] = error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : undefined,
    code: issue.code,
    path: issue.path,
  }));
  return new AppError('VALIDATION_ERROR', { details });
}

const HTTP_STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_ERROR',
  423: 'RESOURCE_LOCKED',
  428: 'PRECONDITION_REQUIRED',
  429: 'RATE_LIMITED',
  500: 'INTERNAL',
  501: 'NOT_IMPLEMENTED',
  502: 'UPSTREAM_UNAVAILABLE',
  503: 'SERVICE_DEGRADED',
};

/** Stable mapping from an HTTP status (e.g. Nest `HttpException`) to a code. */
export function errorCodeFromHttpStatus(status: number): ErrorCode {
  return HTTP_STATUS_TO_CODE[status] ?? (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST');
}

/** Retry-After is only emitted for 429/503 per `API.md` §1.4. */
export function isRetryableCode(code: ErrorCode): boolean {
  return code === 'RATE_LIMITED' || code === 'SERVICE_DEGRADED' || code === 'MAINTENANCE_MODE';
}
