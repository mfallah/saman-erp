export function asString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export function asBool(value: unknown): boolean {
  return value === true;
}

export function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}
