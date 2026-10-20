import { vi } from 'vitest';

/** Shared fetch-mock helpers for Vitest tests. */

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorResponse(code: string, status: number, message = 'خطا'): Response {
  return jsonResponse({ error: { code, message, requestId: 'test-request' } }, status);
}

export function mockFetch(handler: (url: string) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => Promise.resolve(handler(String(input)))),
  );
}
