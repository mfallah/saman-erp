/**
 * Typed API client (API.md §1): envelope unwrapping, request-id propagation,
 * Bearer auth from the in-memory store, single refresh-and-retry on 401,
 * error normalization to a stable code + Persian user message.
 */
import { API_BASE } from './config';
import { logger } from './logger';
import { getAccessToken, expireSession, refreshAccessToken } from './auth-store';
import type { ApiMeta, PageMeta, UploadTicket, UploadedFile } from '../types/api';

export interface ApiErrorDetails {
  readonly field?: string;
  readonly path?: readonly (string | number)[];
  readonly rule?: string;
  readonly params?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly messageFa: string;
  readonly messageKey?: string;
  readonly details?: readonly ApiErrorDetails[];
  readonly requestId?: string;
  readonly retryAfter?: number;
  readonly isNetworkError: boolean;

  constructor(init: {
    code: string;
    status: number;
    messageFa: string;
    messageKey?: string;
    details?: readonly ApiErrorDetails[];
    requestId?: string;
    retryAfter?: number;
    isNetworkError?: boolean;
  }) {
    super(init.messageFa);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.messageFa = init.messageFa;
    this.messageKey = init.messageKey;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
    this.isNetworkError = init.isNetworkError ?? false;
  }
}

/** Canonical Persian message per stable error code (API.md §1.4.1). */
const FA_MESSAGES: Record<string, string> = {
  BAD_REQUEST: 'درخواست ارسال‌شده معتبر نیست.',
  VALIDATION_ERROR: 'برخی فیلدها معتبر نیستند؛ لطفاً ورودی‌ها را بررسی کنید.',
  UNAUTHENTICATED: 'برای ادامه باید وارد حساب خود شوید.',
  TOKEN_EXPIRED: 'نشست شما منقضی شده است؛ لطفاً دوباره وارد شوید.',
  MFA_REQUIRED: 'تأیید دومرحله‌ای لازم است.',
  PERMISSIONS_CHANGED: 'دسترسی‌های شما تغییر کرده است؛ صفحه بازخوانی می‌شود.',
  SESSION_REVOKED: 'نشست شما پایان یافته است؛ لطفاً دوباره وارد شوید.',
  REFRESH_TOKEN_REUSED: 'به دلیل نگرانی امنیتی، نشست شما بسته شد؛ دوباره وارد شوید.',
  STEP_UP_REQUIRED: 'این عملیات نیازمند تأیید هویت مجدد است.',
  FORBIDDEN: 'شما به این بخش دسترسی ندارید.',
  SCOPE_DENIED: 'دسترسی شما به این شعبه یا انبار محدود است.',
  IP_NOT_ALLOWED: 'آدرس شبکه شما مجاز نیست.',
  NOT_FOUND: 'موردی یافت نشد.',
  METHOD_NOT_ALLOWED: 'این عملیات مجاز نیست.',
  CONFLICT: 'این مقدار قبلاً ثبت شده است.',
  VERSION_CONFLICT: 'اطلاعات تغییر کرده است؛ لطفاً صفحه را بازخوانی و دوباره تلاش کنید.',
  APPROVAL_REQUIRED: 'این عملیات نیازمند تأیید تأییدکننده است.',
  APPROVAL_PENDING: 'درخواست تأیید مشابهی در انتظار تصمیم است.',
  IDEMPOTENCY_IN_PROGRESS: 'درخواست قبلی در حال پردازش است؛ چند لحظه بعد تلاش کنید.',
  IDEMPOTENCY_KEY_REUSED: 'این درخواست تکراری است؛ لطفاً عملیات را از نو انجام دهید.',
  DOCUMENT_STATE_INVALID: 'وضعیت سند اجازه این عملیات را نمی‌دهد.',
  PAYLOAD_TOO_LARGE: 'حجم داده بیش از حد مجاز است.',
  UNSUPPORTED_MEDIA_TYPE: 'نوع فایل پشتیبانی نمی‌شود.',
  RULE_VIOLATION: 'قاعده‌ای از سامانه مانع انجام این عملیات شد.',
  INSUFFICIENT_STOCK: 'موجودی کافی برای این اقلام وجود ندارد.',
  PERIOD_CLOSED: 'دوره مالی بسته است و ثبت سند امکان‌پذیر نیست.',
  FISCAL_YEAR_CLOSED: 'سال مالی بسته است.',
  JOURNAL_UNBALANCED: 'جمع بدهکار و بستانکار برابر نیست.',
  COST_CENTER_REQUIRED: 'انتخاب مرکز هزینه الزامی است.',
  PRICE_BELOW_MARGIN: 'قیمت پیشنهادی کمتر از حد سود مجاز است.',
  CURRENT_PASSWORD_INVALID: 'رمز عبور فعلی نادرست است.',
  PASSWORD_POLICY_VIOLATION: 'رمز عبور با سیاست امنیتی سازگار نیست.',
  OTP_INVALID: 'کد یکبار مصرف نادرست است.',
  OTP_EXPIRED: 'کد یکبار مصرف منقضی شده است.',
  OTP_ATTEMPTS_EXCEEDED: 'تعداد تلاش‌های وارد کردن کد بیش از حد مجاز است.',
  OTP_RESEND_TOO_SOON: 'برای ارسال مجدد کد کمی صبر کنید.',
  UPLOAD_UNSUPPORTED_TYPE: 'نوع فایل مجاز نیست.',
  UPLOAD_CHECKSUM_MISMATCH: 'فایل به‌درستی بارگذاری نشد؛ دوباره تلاش کنید.',
  IMPORT_VALIDATION_FAILED: 'برخی سطرهای فایل ورودی معتبر نیستند.',
  RESOURCE_LOCKED: 'این مورد توسط کاربر دیگری در حال ویرایش است.',
  PRECONDITION_REQUIRED: 'نسخه سند را بازخوانی و دوباره تلاش کنید.',
  RATE_LIMITED: 'تعداد درخواست‌ها زیاد است؛ کمی بعد تلاش کنید.',
  NOT_IMPLEMENTED: 'این قابلیت هنوز در سامانه پیاده‌سازی نشده است.',
  UPSTREAM_UNAVAILABLE: 'سرویس بیرونی در دسترس نیست؛ تلاش مجدد انجام می‌شود.',
  UPSTREAM_INVALID_RESPONSE: 'پاسخ سرویس بیرونی معتبر نیست.',
  SERVICE_DEGRADED: 'سامانه موقتاً با ظرفیت محدود کار می‌کند.',
  MAINTENANCE_MODE: 'سامانه در حال نگهداری است.',
  INTERNAL: 'خطای غیرمنتظره‌ای رخ داد؛ لطفاً با پشتیبانی تماس بگیرید.',
  NETWORK_ERROR: 'ارتباط با سرور برقرار نشد؛ اتصال شبکه را بررسی کنید.',
};

export function persianMessageForCode(code: string, fallback?: string): string {
  return FA_MESSAGES[code] ?? fallback ?? FA_MESSAGES.INTERNAL ?? 'خطای نامشخص';
}

/** True when the API has not implemented the feature yet (`501`). */
export function isNotImplemented(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'NOT_IMPLEMENTED';
}

export function toFaErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.messageFa;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return FA_MESSAGES.INTERNAL ?? 'خطای نامشخص';
}

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[] | null | undefined;
export type QueryParams = Record<string, QueryValue>;

/** Builds the query string, comma-joining arrays and skipping empty values. */
export function buildQueryString(params?: QueryParams): string {
  if (params === undefined) {
    return '';
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 0) {
        search.set(key, value.join(','));
      }
    } else {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query.length > 0 ? `?${query}` : '';
}

interface RequestInitEx {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly params?: QueryParams;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly idempotencyKey?: string;
  readonly ifMatch?: string | number;
  readonly skipAuth?: boolean;
  readonly signal?: AbortSignal;
}

export interface PageResult<T> {
  readonly items: T[];
  readonly meta: ApiMeta;
  readonly pagination?: PageMeta;
}

interface ErrorEnvelope {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly messageKey?: string;
    readonly details?: readonly ApiErrorDetails[];
    readonly requestId?: string;
    readonly retryAfter?: number;
  };
}

function normalizeError(status: number, payload: unknown, requestId: string): ApiError {
  const envelope = payload as ErrorEnvelope | null;
  const code = envelope?.error?.code ?? (status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL');
  const serverMessage = envelope?.error?.message;
  return new ApiError({
    code,
    status,
    messageFa: persianMessageForCode(code, serverMessage),
    messageKey: envelope?.error?.messageKey,
    details: envelope?.error?.details,
    requestId: envelope?.error?.requestId ?? requestId,
    retryAfter: envelope?.error?.retryAfter,
  });
}

function buildHeaders(init: RequestInitEx, requestId: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Request-ID': requestId,
    ...init.headers,
  };
  if (!init.skipAuth) {
    const token = getAccessToken();
    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (init.idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = init.idempotencyKey;
  }
  if (init.ifMatch !== undefined) {
    headers['If-Match'] = `"${init.ifMatch}"`;
  }
  return headers;
}

const HARD_AUTH_FAILURES = new Set(['SESSION_REVOKED', 'REFRESH_TOKEN_REUSED']);

async function executeFetch(init: RequestInitEx, requestId: string): Promise<Response> {
  const url = `${API_BASE}${init.path}${buildQueryString(init.params)}`;
  return fetch(url, {
    method: init.method,
    headers: buildHeaders(init, requestId),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'include',
    signal: init.signal,
  });
}

async function parseErrorBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function request<T>(init: RequestInitEx): Promise<T> {
  const requestId = newRequestId();
  let response: Response;
  try {
    response = await executeFetch(init, requestId);
  } catch (error) {
    logger.warn('network request failed', { path: init.path, error: String(error) });
    throw new ApiError({
      code: 'NETWORK_ERROR',
      status: 0,
      messageFa: FA_MESSAGES.NETWORK_ERROR ?? 'ارتباط با سرور برقرار نشد.',
      requestId,
      isNetworkError: true,
    });
  }

  if (response.status === 401 && init.skipAuth !== true) {
    const payload = await parseErrorBody(response.clone());
    const error = normalizeError(401, payload, requestId);
    if (HARD_AUTH_FAILURES.has(error.code)) {
      expireSession(error.code);
      throw error;
    }
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      expireSession('refresh_failed');
      throw new ApiError({
        code: 'SESSION_REVOKED',
        status: 401,
        messageFa: FA_MESSAGES.SESSION_REVOKED ?? 'نشست شما پایان یافته است.',
        requestId,
      });
    }
    try {
      response = await executeFetch(init, requestId);
    } catch (networkError) {
      throw new ApiError({
        code: 'NETWORK_ERROR',
        status: 0,
        messageFa: FA_MESSAGES.NETWORK_ERROR ?? 'ارتباط با سرور برقرار نشد.',
        requestId,
        isNetworkError: true,
        ...(networkError instanceof Error ? { messageKey: networkError.message } : {}),
      });
    }
  }

  if (!response.ok) {
    const payload = await parseErrorBody(response);
    const error = normalizeError(response.status, payload, requestId);
    logger.info('api error', { path: init.path, status: response.status, code: error.code });
    throw error;
  }

  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (text.length === 0) {
    return undefined as T;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ApiError({
      code: 'UPSTREAM_INVALID_RESPONSE',
      status: response.status,
      messageFa: FA_MESSAGES.UPSTREAM_INVALID_RESPONSE ?? 'پاسخ سرور معتبر نیست.',
      requestId,
    });
  }
  if (parsed !== null && typeof parsed === 'object' && 'data' in parsed) {
    return (parsed as { data: T }).data;
  }
  return parsed as T;
}

async function requestMeta<T>(init: RequestInitEx): Promise<{ data: T; meta: ApiMeta }> {
  // The envelope's meta is needed for pagination; re-implement the tiny tail of
  // `request` because the shared helper intentionally returns only `data`.
  const requestId = newRequestId();
  let response: Response;
  try {
    response = await executeFetch(init, requestId);
  } catch (error) {
    throw new ApiError({
      code: 'NETWORK_ERROR',
      status: 0,
      messageFa: FA_MESSAGES.NETWORK_ERROR ?? 'ارتباط با سرور برقرار نشد.',
      requestId,
      isNetworkError: true,
      ...(error instanceof Error ? { messageKey: error.message } : {}),
    });
  }
  if (response.status === 401 && init.skipAuth !== true) {
    const payload = await parseErrorBody(response.clone());
    const error = normalizeError(401, payload, requestId);
    if (HARD_AUTH_FAILURES.has(error.code)) {
      expireSession(error.code);
      throw error;
    }
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      expireSession('refresh_failed');
      throw new ApiError({
        code: 'SESSION_REVOKED',
        status: 401,
        messageFa: FA_MESSAGES.SESSION_REVOKED ?? 'نشست شما پایان یافته است.',
        requestId,
      });
    }
    response = await executeFetch(init, requestId);
  }
  if (!response.ok) {
    const payload = await parseErrorBody(response);
    throw normalizeError(response.status, payload, requestId);
  }
  const text = await response.text();
  const parsed = text.length === 0 ? null : (JSON.parse(text) as { data?: T; meta?: ApiMeta });
  return { data: parsed?.data as T, meta: parsed?.meta ?? { requestId } };
}

export const api = {
  get<T>(path: string, params?: QueryParams, signal?: AbortSignal): Promise<T> {
    return request<T>({ method: 'GET', path, params, signal });
  },

  async getPage<T>(path: string, params?: QueryParams, signal?: AbortSignal): Promise<PageResult<T>> {
    const { data, meta } = await requestMeta<readonly T[]>({ method: 'GET', path, params, signal });
    return {
      items: Array.isArray(data) ? [...data] : [],
      meta,
      pagination: meta.pagination,
    };
  },

  post<T>(
    path: string,
    body?: unknown,
    options?: {
      idempotencyKey?: string;
      headers?: Record<string, string>;
      skipAuth?: boolean;
      ifMatch?: string | number;
    },
  ): Promise<T> {
    return request<T>({ method: 'POST', path, body, ...options });
  },

  put<T>(
    path: string,
    body?: unknown,
    options?: { ifMatch?: string | number; headers?: Record<string, string> },
  ): Promise<T> {
    return request<T>({ method: 'PUT', path, body, ...options });
  },

  patch<T>(
    path: string,
    body?: unknown,
    options?: { ifMatch?: string | number; headers?: Record<string, string> },
  ): Promise<T> {
    return request<T>({ method: 'PATCH', path, body, ...options });
  },

  del<T>(path: string, body?: unknown): Promise<T> {
    return request<T>({ method: 'DELETE', path, body });
  },
};

export type UploadPurpose =
  | 'product_media'
  | 'invoice'
  | 'attachment'
  | 'avatar'
  | 'import'
  | 'cheque_image';

async function sha256Hex(file: File): Promise<string | null> {
  try {
    if (typeof crypto === 'undefined' || crypto.subtle === undefined) {
      return null;
    }
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Two-step presigned upload (API.md §7): request ticket → PUT bytes to storage →
 * complete. Never reports success unless the storage upload succeeded.
 */
export async function uploadFile(file: File, purpose: UploadPurpose): Promise<UploadedFile> {
  const ticket = await api.post<UploadTicket>('/files/uploads', {
    fileName: file.name,
    contentType: file.type,
    sizeBytes: file.size,
    purpose,
  }, { idempotencyKey: newRequestId() });

  if (ticket.uploadUrl === undefined || ticket.fileId === undefined) {
    throw new ApiError({
      code: 'UPSTREAM_INVALID_RESPONSE',
      status: 502,
      messageFa: 'سرور آدرس بارگذاری فایل را برنگرداند.',
    });
  }

  const uploadResponse = await fetch(ticket.uploadUrl, {
    method: ticket.method ?? 'PUT',
    headers: ticket.headers ?? { 'Content-Type': file.type },
    body: file,
  });
  if (!uploadResponse.ok) {
    throw new ApiError({
      code: 'UPSTREAM_UNAVAILABLE',
      status: 502,
      messageFa: 'بارگذاری فایل در فضای ذخیره‌سازی ناموفق بود.',
    });
  }

  const sha256 = await sha256Hex(file);
  const completed = await api.post<UploadedFile>(
    `/files/uploads/${ticket.fileId}/complete`,
    {
      sizeBytes: file.size,
      ...(sha256 === null ? {} : { sha256 }),
    },
    { idempotencyKey: newRequestId() },
  );
  return completed ?? { id: ticket.fileId, fileName: file.name, contentType: file.type, sizeBytes: file.size };
}
