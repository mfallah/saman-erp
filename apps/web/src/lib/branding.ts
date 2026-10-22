/** Branding retrieved from the `branding` settings group (logo/favicon/app name). */
import { useQuery } from '@tanstack/react-query';

import { api } from './api-client';

export interface Branding {
  readonly logoDataUrl?: string;
  readonly faviconDataUrl?: string;
  readonly appName?: string;
}

export function useBranding() {
  return useQuery({
    queryKey: ['branding'],
    queryFn: async (): Promise<Branding> => {
      try {
        const data = await api.get<Record<string, unknown>>('/settings/branding');
        const pick = (key: string): string | undefined =>
          typeof data[key] === 'string' && (data[key] as string).length > 0 ? (data[key] as string) : undefined;
        return { logoDataUrl: pick('logoDataUrl'), faviconDataUrl: pick('faviconDataUrl'), appName: pick('appName') };
      } catch {
        return {};
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function applyFavicon(href: string | undefined): void {
  if (href === undefined) return;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link === null) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = href.startsWith('data:image/svg') ? 'image/svg+xml' : 'image/png';
  link.href = href;
}
