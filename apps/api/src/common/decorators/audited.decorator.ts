import { SetMetadata } from '@nestjs/common';

/** Audit metadata consumed by the audit interceptor of the platform module. */
export const AUDITED_ACTION_KEY = 'saman:auditedAction';

/**
 * Declares the stable audit action written on a successful mutation
 * (e.g. `@Audited('product.update')`, `API.md` §10.2, `SECURITY.md` audit rules).
 * The interceptor needs the request tenant (auth guard) and the `AUDIT` port; it
 * is wired with the identity module so writes are recorded in the caller's tx.
 */
export function Audited(action: string): MethodDecorator & ClassDecorator {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(action)) {
    throw new Error(`Invalid audit action (expected resource.action): ${action}`);
  }
  return SetMetadata(AUDITED_ACTION_KEY, action);
}
