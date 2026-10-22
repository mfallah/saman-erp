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
        const data = await api.get<{ items: readonly { key: string; value: unknown }[] }>('/settings/branding');
        const map = new Map(data.items.map((item) => [item.key, item.value]));
        const pick = (key: string): string | undefined => {
          const value = map.get(key);
          if (typeof value !== 'string' || value.length === 0) return undefined;
          try {
            const parsed: unknown = JSON.parse(value);
            return typeof parsed === 'string' && parsed.length > 0 ? parsed : undefined;
          } catch {
            return value;
          }
        };
        return {
          logoDataUrl: pick('branding.logo'),
          faviconDataUrl: pick('branding.favicon'),
          appName: pick('branding.app_name'),
        };
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
