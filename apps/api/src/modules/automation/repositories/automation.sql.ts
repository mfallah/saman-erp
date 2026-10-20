export function asString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}
