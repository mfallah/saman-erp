/** Cheque lifecycle FSM per direction, including issued and post-clear bounce (B-13). */
import { describe, expect, it } from 'vitest';
import {
  accountingEventFor,
  allowedTransitions,
  assertChequeTransition,
  canTransition,
  initialChequeStatus,
} from '../cheque/cheque-fsm';

describe('cheque state machine', () => {
  it('starts received cheques as received and issued cheques as issued', () => {
    expect(initialChequeStatus('received')).toBe('received');
    expect(initialChequeStatus('issued')).toBe('issued');
  });

  it('follows received → in_custody → deposited → cleared', () => {
    expect(canTransition('received', 'received', 'in_custody')).toBe(true);
    expect(canTransition('received', 'in_custody', 'deposited')).toBe(true);
    expect(canTransition('received', 'deposited', 'cleared')).toBe(true);
  });

  it('rejects an undocumented skip (received → cleared)', () => {
    expect(canTransition('received', 'received', 'cleared')).toBe(false);
    expect(() => assertChequeTransition('received', 'received', 'cleared')).toThrow();
  });

  it('rejects any transition from a terminal state', () => {
    for (const terminal of ['returned', 'cancelled', 'endorsed'] as const) {
      expect(allowedTransitions('received', terminal)).toHaveLength(0);
    }
    expect(allowedTransitions('received', 'bounced')).toHaveLength(0);
  });

  it('allows a post-clear bounce for received cheques only', () => {
    expect(canTransition('received', 'cleared', 'bounced')).toBe(true);
    expect(canTransition('issued', 'cleared', 'bounced')).toBe(true);
  });

  it('issues cheques directly to cleared/bounced/cancelled', () => {
    expect(allowedTransitions('issued', 'issued')).toEqual(['cleared', 'bounced', 'returned', 'cancelled']);
    expect(() => assertChequeTransition('issued', 'issued', 'deposited')).toThrow();
  });
});

describe('cheque accounting mapping', () => {
  it('maps deposit and clearing events', () => {
    expect(accountingEventFor('received', 'in_custody', 'deposited').eventType).toBe('cheque.deposited');
    expect(accountingEventFor('received', 'deposited', 'cleared')).toEqual({
      eventType: 'cheque.cleared',
      afterClear: true,
    });
    expect(accountingEventFor('issued', 'issued', 'cleared').eventType).toBe('cheque.issued.cleared');
  });

  it('flags a bounce before clearing differently from after clearing', () => {
    expect(accountingEventFor('received', 'deposited', 'bounced')).toEqual({
      eventType: 'cheque.bounced',
      afterClear: false,
    });
    expect(accountingEventFor('received', 'cleared', 'bounced')).toEqual({
      eventType: 'cheque.bounced',
      afterClear: true,
    });
  });

  it('treats cancellation as a reversal of the registration entry', () => {
    expect(accountingEventFor('received', 'in_custody', 'cancelled')).toEqual({
      eventType: 'cheque.bounced',
      afterClear: false,
    });
  });
});
