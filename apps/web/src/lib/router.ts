import { useParams, useSearch } from '@tanstack/react-router';

/**
 * Reads one path parameter without coupling a page to its route definition
 * (pages are lazy-loaded and must not import the router module).
 */
export function usePathParam(name: string): string {
  const params: Record<string, string | undefined> = useParams({ strict: false });
  const value = params[name];
  if (value === undefined || value === '') {
    throw new Error(`پارامتر مسیر «${name}» یافت نشد.`);
  }
  return value;
}

/** Reads a string search param from the current location (e.g. `redirect`). */
export function useSearchParam(name: string): string | undefined {
  const search: Record<string, unknown> = useSearch({ strict: false });
  const value = search[name];
  return typeof value === 'string' ? value : undefined;
}
