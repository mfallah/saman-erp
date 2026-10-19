/**
 * Runtime constants of the SPA. The API base defaults to the same-origin
 * `/api/v1` (ADR-0011); the Vite dev server proxies `/api` to localhost:4000.
 */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '/api/v1';

/** Auth endpoints live under the same versioned base. */
export const AUTH_BASE = `${API_BASE}/auth`;

export const APP_NAME_FA = 'سامان ERP';

/** localStorage is only allowed for UI preferences (never for tokens). */
export const PREF_KEYS = {
  theme: 'saman.theme',
  sidebarCollapsed: 'saman.sidebar.collapsed',
} as const;
