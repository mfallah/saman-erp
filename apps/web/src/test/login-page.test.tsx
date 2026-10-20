import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../lib/query-client';
import { resetAuthStoreForTests } from '../lib/auth-store';
import { LoginPage } from '../pages/LoginPage';
import { ToastProvider } from '../components/ui/Toast';
import { errorResponse, jsonResponse, mockFetch } from './fetch-mocks';

/**
 * Login page render smoke test.
 *
 * The login page is rendered without the full router: the router module is
 * mocked because the reference sandbox's jsdom environment loads a second React
 * copy through the router package (an environment limitation, not an app bug).
 * Guard/redirect behaviour itself is covered by `guards.test.ts`.
 */
const pushMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: pushMock } }),
  createMemoryHistory: () => ({}),
}));

vi.mock('../lib/router', () => ({
  useSearchParam: () => undefined,
  usePathParam: () => 'test-id',
}));

function renderLogin(): void {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 0 } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <LoginPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('login page', () => {
  beforeEach(() => {
    resetAuthStoreForTests();
    pushMock.mockClear();
    vi.unstubAllGlobals();
  });

  it('renders the Persian login form when the API is unavailable', async () => {
    mockFetch((url) => {
      if (url.endsWith('/auth/config')) {
        return errorResponse('NOT_FOUND', 404);
      }
      return errorResponse('UNAVAILABLE', 503);
    });

    renderLogin();

    expect(await screen.findByRole('button', { name: 'ورود به سامانه' })).toBeTruthy();
    expect(screen.getByText('ورود با کد یکبار مصرف')).toBeTruthy();
    // The label text also contains the required-field asterisk.
    expect(screen.getByLabelText(/شناسه کاربری یا موبایل/)).toBeTruthy();
    expect(screen.getByLabelText(/رمز عبور/)).toBeTruthy();
  });

  it('shows organisation branding from /auth/config', async () => {
    mockFetch((url) => {
      if (url.endsWith('/auth/config')) {
        return jsonResponse({ data: { orgName: 'فروشگاه کرکسی', passwordLogin: true, otpLogin: true } });
      }
      return errorResponse('NOT_FOUND', 404);
    });

    renderLogin();

    expect(await screen.findByText('فروشگاه کرکسی')).toBeTruthy();
  });
});
