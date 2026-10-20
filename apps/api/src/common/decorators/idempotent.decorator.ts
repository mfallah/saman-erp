import { SetMetadata } from '@nestjs/common';

/** Idempotency metadata consumed by the idempotency interceptor (identity/platform). */
export const IDEMPOTENCY_KEY = 'saman:idempotency';

export interface IdempotentOptions {
  /** `true` = the `Idempotency-Key` header is mandatory (`IK` endpoints, API.md §1.10). */
  readonly required?: boolean;
  /** TTL override in hours (default 24). */
  readonly ttlHours?: number;
}

/**
 * Marks a mutation as replay-safe (`API.md` §1.10).
 * The interceptor that stores/replays `idempotency_keys` is owned by the platform
 * module delivered alongside the first business modules; the metadata is stable now.
 */
export function Idempotent(options: IdempotentOptions = {}): MethodDecorator {
  return SetMetadata(IDEMPOTENCY_KEY, { ttlHours: 24, ...options });
}
