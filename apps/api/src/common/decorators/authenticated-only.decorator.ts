import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route as "authenticated, no permission key required" (self-service
 * endpoints such as `/auth/me`, session list/revoke, logout, step-up).
 * The global IdentityGuard still enforces a valid session; PermissionsGuard
 * skips the permission requirement. Never use this on business mutations.
 */
export const AUTHENTICATED_ONLY_KEY = 'saman:authenticated-only';
export const AuthenticatedOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHENTICATED_ONLY_KEY, true);
