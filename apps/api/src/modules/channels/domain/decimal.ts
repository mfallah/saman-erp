/** Fixed-point decimal helpers for quantities (`numeric(18,4)`), no floats. */
const SCALE = 10_000n;

export function decimalToUnits(value: string): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const padded = `${fraction}0000`.slice(0, 4);
  const units = BigInt(`${whole === '' ? '0' : whole}${padded}`);
  return negative ? -units : units;
}

export function unitsToDecimal(units: bigint): string {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / SCALE;
  const fraction = (magnitude % SCALE).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function subtractDecimal(a: string, b: string): string {
  return unitsToDecimal(decimalToUnits(a) - decimalToUnits(b));
}

export function maxDecimalZero(value: string): string {
  const units = decimalToUnits(value);
  return units < 0n ? '0.0000' : unitsToDecimal(units);
}
