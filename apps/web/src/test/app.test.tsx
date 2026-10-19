import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { resetAuthStoreForTests } from '../lib/auth-store';
import { errorResponse, jsonResponse, renderApp } from './render-app';

function stubApi(handler: (url: string) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => Promise.resolve(handler(String(input)))),
  );
}

describe('app routing and permission guards', () => {
  beforeEach(() => {
    resetAuthStoreForTests();
    vi.unstubAllGlobals();
  });

  it('redirects unauthenticated visitors to the login screen', async () => {
    stubApi((url) => {
      if (url.endsWith('/auth/refresh')) {
        return errorResponse('UNAUTHENTICATED', 401);
      }
      return errorResponse('NOT_FOUND', 404);
    });

    const { router } = renderApp('/products');

    expect(await screen.findByRole('button', { name: 'ورود به سامانه' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toMatchObject({ redirect: '/products' });
  });

  it('redirects authenticated users without the permission to the 403 screen', async () => {
    stubApi((url) => {
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse({ data: { accessToken: 'token-1', permissionsVersion: 1 } });
      }
      if (url.endsWith('/auth/me')) {
        return jsonResponse({
          data: {
            id: 'user-1',
            fullName: 'کاربر',
            permissions: ['dashboard.read'],
            permissionsVersion: 1,
          },
        });
      }
      return errorResponse('NOT_FOUND', 404);
    });

    const { router } = renderApp('/products');

    expect(await screen.findByRole('heading', { name: 'دسترسی غیرمجاز' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/forbidden');
  });

  it('renders the dashboard shell for an authorized user and degrades gracefully without the API', async () => {
    stubApi((url) => {
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse({ data: { accessToken: 'token-2', permissionsVersion: 1 } });
      }
      if (url.endsWith('/auth/me')) {
        return jsonResponse({
          data: {
            id: 'user-1',
            fullName: 'مدیر سامانه',
            permissions: ['dashboard.read', 'sales.order.read', 'channel.read'],
            permissionsVersion: 1,
            roles: [{ id: 'role-1', name: 'admin', nameFa: 'مدیر کل' }],
          },
        });
      }
      return errorResponse('NOT_FOUND', 404);
    });

    renderApp('/');

    expect(await screen.findByRole('heading', { name: 'داشبورد' })).toBeTruthy();
    expect(screen.getByText('فروش امروز')).toBeTruthy();
    expect(await screen.findByText('دریافت خلاصه داشبورد ناموفق بود.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'حالت تیره' })).toBeTruthy();
  });
});
