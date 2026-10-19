import { redirect } from '@tanstack/react-router';
import { ensureAuthenticated, hasPermission } from './auth-store';

/**
 * Route guards. Unauthenticated visits are redirected to /login with the
 * original path preserved; missing permissions go to the 403 screen. Both
 * decisions are re-evaluated after a silent refresh, so a valid session in the
 * httpOnly cookie is never treated as logged out on reload.
 */
export async function guardAuthenticated(href: string): Promise<void> {
  const authenticated = await ensureAuthenticated();
  if (!authenticated) {
    throw redirect({ to: '/login', search: { redirect: href } });
  }
}

export function guardPermission(permission: string): void {
  if (!hasPermission(permission)) {
    throw redirect({ to: '/forbidden' });
  }
}

/** Login page must not be reachable when a session is already active. */
export async function guardGuest(): Promise<void> {
  const authenticated = await ensureAuthenticated();
  if (authenticated) {
    throw redirect({ to: '/' });
  }
}
