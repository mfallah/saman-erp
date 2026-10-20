/** Small SQL value coercions shared by integrations repositories. */
export function asString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
