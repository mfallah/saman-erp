/**
 * Deterministic fraud heuristics (no ML): velocity, amount anomaly, repeated
 * failed COD, address mismatch and channel failure anomalies. Scores are 0–100
 * and each signal is explainable for the review screen.
 */
export interface FraudSignal {
  readonly code: string;
  readonly score: number;
  readonly reasonFa: string;
}

export interface FraudAssessment {
  readonly score: number;
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly signals: readonly FraudSignal[];
}

export interface FraudInput {
  readonly orderCount24h: number;
  readonly orderAmount: number;
  readonly meanAmount: number;
  readonly stdDevAmount: number;
  readonly failedCodCount: number;
  readonly addressMismatch: boolean;
  readonly channelFailureRate: number;
  readonly newCustomer: boolean;
}

function velocity(input: FraudInput): FraudSignal | null {
  if (input.orderCount24h <= 3) return null;
  const score = Math.min(100, 20 + (input.orderCount24h - 3) * 15);
  return {
    code: 'velocity_24h',
    score,
    reasonFa: `${input.orderCount24h} سفارش در ۲۴ ساعت گذشته ثبت شده است.`,
  };
}

function amountAnomaly(input: FraudInput): FraudSignal | null {
  if (input.stdDevAmount <= 0) return null;
  const z = (input.orderAmount - input.meanAmount) / input.stdDevAmount;
  if (z < 2.5) return null;
  return {
    code: 'amount_anomaly',
    score: Math.min(100, Math.round(z * 20)),
    reasonFa: 'مبلغ سفارش به‌طور غیرعادی از الگوی مشتری فاصله دارد.',
  };
}

function failedCod(input: FraudInput): FraudSignal | null {
  if (input.failedCodCount < 2) return null;
  return {
    code: 'failed_cod',
    score: Math.min(100, input.failedCodCount * 20),
    reasonFa: 'سابقهٔ پرداخت در محل ناموفق برای این مشتری وجود دارد.',
  };
}

function addressMismatch(input: FraudInput): FraudSignal | null {
  if (!input.addressMismatch) return null;
  return {
    code: 'address_mismatch',
    score: 35,
    reasonFa: 'نشانی ارسال با نشانی ثبت‌شدهٔ مشتری همخوانی ندارد.',
  };
}

function channelAnomaly(input: FraudInput): FraudSignal | null {
  if (input.channelFailureRate < 0.2) return null;
  return {
    code: 'channel_anomaly',
    score: Math.min(100, Math.round(input.channelFailureRate * 100)),
    reasonFa: 'نرخ خطای کانال در بازهٔ اخیر بالاست.',
  };
}

function newCustomerHighValue(input: FraudInput): FraudSignal | null {
  if (!input.newCustomer || input.orderAmount < input.meanAmount * 3) return null;
  return {
    code: 'new_customer_high_value',
    score: 45,
    reasonFa: 'مشتری جدید با سفارش بسیار بزرگ‌تر از میانگین.',
  };
}

export function assessFraud(input: FraudInput): FraudAssessment {
  const signals = [
    velocity(input),
    amountAnomaly(input),
    failedCod(input),
    addressMismatch(input),
    channelAnomaly(input),
    newCustomerHighValue(input),
  ].filter((signal): signal is FraudSignal => signal !== null);

  // Weighted max + small corroboration bonus; never exceeds 100.
  const max = signals.reduce((value, signal) => Math.max(value, signal.score), 0);
  const bonus = signals.length > 1 ? Math.min(20, (signals.length - 1) * 10) : 0;
  const score = Math.min(100, max + bonus);
  const severity = score >= 80 ? 'critical' : score >= 60 ? 'high' : score >= 35 ? 'medium' : 'low';
  return { score, severity, signals };
}
