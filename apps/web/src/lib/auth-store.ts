/**
 * In-memory auth store (ADR-0004).
 *
 * The access token lives ONLY in a module-scoped variable: never in
 * localStorage/sessionStorage, never in a cookie managed by JS. A page reload
 * silently restores the session from the httpOnly refresh cookie through
 * `POST /auth/refresh`. UI preferences (theme/sidebar) may use localStorage,
 * tokens may not.
 */
import { AUTH_BASE } from './config';
import { logger } from './logger';
import type {
  AuthConfig,
  AuthTokens,
  CurrentUser,
  OtpChallengeResult,
} from '../types/api';

export type AuthStatus = 'booting' | 'anonymous' | 'authenticated';

export interface AuthSnapshot {
  readonly status: AuthStatus;
  readonly user: CurrentUser | null;
  readonly permissions: ReadonlySet<string>;
  readonly permissionsVersion: number;
}

type Listener = () => void;
type ExpiryListener = (reason: string) => void;

let accessToken: string | null = null;
let state: AuthSnapshot = {
  status: 'booting',
  user: null,
  permissions: new Set<string>(),
  permissionsVersion: 0,
};
let bootstrapPromise: Promise<boolean> | null = null;
let refreshPromise: Promise<boolean> | null = null;

const listeners = new Set<Listener>();
const expiryListeners = new Set<ExpiryListener>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function readCsrfToken(): string | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const match = /(?:^|;\s*)csrf_token=([^;]+)/.exec(document.cookie);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  const csrf = readCsrfToken();
  if (csrf !== null) {
    headers['X-CSRF-Token'] = csrf;
  }
  if (accessToken !== null) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

interface Envelope<T> {
  readonly data: T;
}

async function readEnvelope<T>(response: Response): Promise<T | null> {
  try {
    const payload = (await response.json()) as Envelope<T>;
    return payload.data ?? null;
  } catch {
    return null;
  }
}

function applyAnonymous(): void {
  accessToken = null;
  state = {
    status: 'anonymous',
    user: null,
    permissions: new Set<string>(),
    permissionsVersion: 0,
  };
  emit();
}

function applyUser(user: CurrentUser): void {
  const permissions = new Set<string>(user.permissions ?? []);
  state = {
    status: 'authenticated',
    user,
    permissions,
    permissionsVersion: user.permissionsVersion ?? state.permissionsVersion,
  };
  emit();
}

async function fetchPermissions(): Promise<readonly string[]> {
  try {
    const response = await fetch(`${AUTH_BASE}/permissions`, {
      headers: authHeaders(),
      credentials: 'include',
    });
    if (!response.ok) {
      return [];
    }
    const payload = await readEnvelope<{ keys?: readonly string[] }>(response);
    return payload?.keys ?? [];
  } catch (error) {
    logger.warn('permission fetch failed', { error: String(error) });
    return [];
  }
}

async function fetchCurrentUser(): Promise<CurrentUser | null> {
  try {
    const response = await fetch(`${AUTH_BASE}/me`, {
      headers: authHeaders(),
      credentials: 'include',
    });
    if (!response.ok) {
      return null;
    }
    const user = await readEnvelope<CurrentUser>(response);
    if (user === null) {
      return null;
    }
    if (user.permissions === undefined) {
      const keys = await fetchPermissions();
      return { ...user, permissions: keys };
    }
    return user;
  } catch (error) {
    logger.warn('current user fetch failed', { error: String(error) });
    return null;
  }
}

async function performRefresh(): Promise<boolean> {
  try {
    const response = await fetch(`${AUTH_BASE}/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: authHeaders(),
    });
    if (!response.ok) {
      logger.info('refresh rejected', { status: response.status });
      applyAnonymous();
      return false;
    }
    const tokens = await readEnvelope<AuthTokens>(response);
    if (tokens?.accessToken === undefined) {
      logger.warn('refresh returned malformed payload');
      applyAnonymous();
      return false;
    }
    accessToken = tokens.accessToken;
    state = { ...state, permissionsVersion: tokens.permissionsVersion ?? state.permissionsVersion };
    return true;
  } catch (error) {
    logger.warn('refresh request failed', { error: String(error) });
    applyAnonymous();
    return false;
  }
}

/** Single-flight silent refresh; used by the API client on 401. */
export function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise === null) {
    refreshPromise = performRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

/** Restores a session on app boot from the httpOnly refresh cookie. */
export function bootstrap(): Promise<boolean> {
  if (state.status === 'authenticated') {
    return Promise.resolve(true);
  }
  if (bootstrapPromise === null) {
    bootstrapPromise = (async () => {
      const refreshed = await refreshAccessToken();
      if (!refreshed) {
        return false;
      }
      const user = await fetchCurrentUser();
      if (user === null) {
        applyAnonymous();
        return false;
      }
      applyUser(user);
      return true;
    })().finally(() => {
      bootstrapPromise = null;
    });
  }
  return bootstrapPromise;
}

/** Called by the login page after a successful password/OTP exchange. */
export async function completeLogin(tokens: AuthTokens, user?: CurrentUser): Promise<void> {
  accessToken = tokens.accessToken;
  state = {
    ...state,
    permissionsVersion: tokens.permissionsVersion ?? state.permissionsVersion,
  };
  if (user !== undefined) {
    applyUser(user);
    return;
  }
  const currentUser = await fetchCurrentUser();
  if (currentUser === null) {
    applyAnonymous();
    return;
  }
  applyUser(currentUser);
}

/** Revokes the session server-side (best effort) and clears memory. */
export async function logout(): Promise<void> {
  try {
    await fetch(`${AUTH_BASE}/logout`, {
      method: 'POST',
      headers: authHeaders(),
      credentials: 'include',
    });
  } catch (error) {
    logger.warn('logout request failed', { error: String(error) });
  } finally {
    applyAnonymous();
  }
}

/**
 * Clears the session after a hard auth failure and notifies the shell so it can
 * show a Persian message and route to /login.
 */
export function expireSession(reason: string): void {
  applyAnonymous();
  logger.info('session expired', { reason });
  for (const listener of expiryListeners) {
    listener(reason);
  }
}

export function onSessionExpired(listener: ExpiryListener): () => void {
  expiryListeners.add(listener);
  return () => {
    expiryListeners.delete(listener);
  };
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getSnapshot(): AuthSnapshot {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Exact permission-key check (default-deny, ADR-0008). */
export function hasPermission(permission: string): boolean {
  if (state.status !== 'authenticated') {
    return false;
  }
  if (state.permissions.has('*')) {
    return true;
  }
  return state.permissions.has(permission);
}

export function hasAnyPermission(permissions: readonly string[]): boolean {
  return permissions.some((permission) => hasPermission(permission));
}

export function ensureAuthenticated(): Promise<boolean> {
  if (state.status === 'authenticated') {
    return Promise.resolve(true);
  }
  return bootstrap();
}

/** Public auth bootstrap data for the login screen (public endpoint). */
export async function fetchAuthConfig(): Promise<AuthConfig | null> {
  try {
    const response = await fetch(`${AUTH_BASE}/config`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return null;
    }
    return await readEnvelope<AuthConfig>(response);
  } catch (error) {
    logger.warn('auth config fetch failed', { error: String(error) });
    return null;
  }
}

/** Device identity for 2FA trust; a stable hash of UA/platform/timezone. */
export function deviceFingerprint(): string {
  if (typeof navigator === 'undefined') {
    return 'server';
  }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const raw = `${navigator.userAgent}|${navigator.platform}|${timezone}|${screen.width}x${screen.height}`;
  let hash = 5381;
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash << 5) + hash + raw.charCodeAt(index)) | 0;
  }
  return `fp_${Math.abs(hash).toString(16)}`;
}

/** Test/reset seam; never used by production code. */
export function resetAuthStoreForTests(): void {
  accessToken = null;
  state = {
    status: 'booting',
    user: null,
    permissions: new Set<string>(),
    permissionsVersion: 0,
  };
  bootstrapPromise = null;
  refreshPromise = null;
  listeners.clear();
  expiryListeners.clear();
}

export { type OtpChallengeResult };
