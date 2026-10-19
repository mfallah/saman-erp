import { useSyncExternalStore } from 'react';
import {
  getSnapshot,
  hasAnyPermission,
  hasPermission,
  subscribe,
  type AuthSnapshot,
} from './auth-store';

/** Subscribes a component to auth state (memory-only token store). */
export function useAuth(): AuthSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useHasPermission(permission: string | undefined): boolean {
  const auth = useAuth();
  if (permission === undefined) {
    return true;
  }
  // `auth` is read so the hook re-renders when permissions change.
  void auth;
  return hasPermission(permission);
}

export function useHasAnyPermission(permissions: readonly string[] | undefined): boolean {
  const auth = useAuth();
  void auth;
  if (permissions === undefined || permissions.length === 0) {
    return true;
  }
  return hasAnyPermission(permissions);
}

export function useCurrentUser(): AuthSnapshot['user'] {
  return useAuth().user;
}
