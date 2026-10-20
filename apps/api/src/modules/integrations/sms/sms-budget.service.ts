/**
 * Daily monetary SMS/voice budget in Redis (R1-security voice/OTP budgets).
 * Reserve-before-send, release on failure, reconcile to the provider amount.
 */
import type { KeyValueStore } from '../infrastructure/key-value';
import { DEFAULT_SMS_DAILY_BUDGET_IRR, DEFAULT_VOICE_DAILY_BUDGET_IRR } from '../limo/limo.constants';
import { LimoError } from '../limo/limo.errors';

export interface BudgetReservation {
  readonly key: string;
  readonly amountIrr: number;
  readonly kind: 'sms' | 'voice';
}

export interface BudgetLimits {
  readonly smsDailyIrr?: number;
  readonly voiceDailyIrr?: number;
  readonly now?: () => Date;
}

export class SmsBudgetService {
  private readonly smsLimit: number;
  private readonly voiceLimit: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: KeyValueStore,
    limits: BudgetLimits = {},
  ) {
    this.smsLimit = limits.smsDailyIrr ?? Number(process.env.SMS_DAILY_BUDGET_IRR ?? DEFAULT_SMS_DAILY_BUDGET_IRR);
    this.voiceLimit =
      limits.voiceDailyIrr ?? Number(process.env.OTP_VOICE_DAILY_BUDGET_IRR ?? DEFAULT_VOICE_DAILY_BUDGET_IRR);
    this.now = limits.now ?? (() => new Date());
  }

  private key(kind: 'sms' | 'voice', organizationId: string): string {
    const day = this.now().toISOString().slice(0, 10);
    return `budget:${kind}:${organizationId}:${day}`;
  }

  private limit(kind: 'sms' | 'voice'): number {
    return kind === 'sms' ? this.smsLimit : this.voiceLimit;
  }

  async reserve(
    organizationId: string,
    amountIrr: number,
    kind: 'sms' | 'voice' = 'sms',
  ): Promise<BudgetReservation> {
    const key = this.key(kind, organizationId);
    const amount = Math.max(0, Math.ceil(amountIrr));
    if (amount === 0) return { key, amountIrr: 0, kind };
    const total = await this.store.incrBy(key, amount, 2 * 24 * 60 * 60);
    if (total > this.limit(kind)) {
      await this.store.incrBy(key, -amount);
      throw new LimoError('BUDGET_EXHAUSTED');
    }
    return { key, amountIrr: amount, kind };
  }

  async release(reservation: BudgetReservation): Promise<void> {
    if (reservation.amountIrr === 0) return;
    await this.store.incrBy(reservation.key, -reservation.amountIrr);
  }

  async reconcile(reservation: BudgetReservation, actualIrr: number | null): Promise<void> {
    if (actualIrr === null || reservation.kind === 'voice') return;
    const actual = Math.max(0, Math.ceil(actualIrr));
    const delta = actual - reservation.amountIrr;
    if (delta !== 0) await this.store.incrBy(reservation.key, delta);
  }

  async spent(organizationId: string, kind: 'sms' | 'voice' = 'sms'): Promise<number> {
    return Number((await this.store.get(this.key(kind, organizationId))) ?? '0');
  }

  async remaining(organizationId: string, kind: 'sms' | 'voice' = 'sms'): Promise<number> {
    return Math.max(0, this.limit(kind) - (await this.spent(organizationId, kind)));
  }
}
