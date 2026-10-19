import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api-client';

/**
 * Server-state defaults (ADR-0011): modest stale time, no retries for
 * auth/permission/validation failures, two retries with backoff for transient
 * faults, and no mutation retries (mutations carry Idempotency-Key explicitly).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError) {
            if (error.status === 0) {
              return failureCount < 1;
            }
            if ([400, 401, 403, 404, 409, 422, 501].includes(error.status)) {
              return false;
            }
          }
          return failureCount < 2;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}
