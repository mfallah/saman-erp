import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createQueryClient } from '../lib/query-client';
import { createAppRouter } from '../router';
import { ToastProvider } from '../components/ui/Toast';

/** Builds a JSON `Response` for fetch mocks (API envelope or error envelope). */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorResponse(code: string, status: number, message = 'خطا'): Response {
  return jsonResponse({ error: { code, message, requestId: 'test-request' } }, status);
}

/**
 * Renders the real route tree with an in-memory history and isolated query
 * cache, so guard redirects and page renders are exercised end to end.
 */
export function renderApp(initialPath: string): ReturnType<typeof render> & {
  router: ReturnType<typeof createAppRouter>;
} {
  const history = createMemoryHistory({ initialEntries: [initialPath] });
  const router = createAppRouter(history);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false },
    mutations: { retry: false },
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );

  return Object.assign(result, { router });
}
