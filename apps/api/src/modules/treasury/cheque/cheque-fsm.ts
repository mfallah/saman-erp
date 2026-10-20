/**
 * Cheque state machine per direction (`DATA-MODEL §2.13`, R1-accounting B-13).
 *
 * `issued` is a valid **initial** state for outbound cheques; a received cheque
 * follows `received → in_custody → deposited → cleared`, and a bounce may happen
 * before or after clearing (the accounting differs, the state does not).
 */
import { AppError } from '@saman/shared';

export type ChequeDirection = 'received' | 'issued';

export const CHEQUE_STATUSES = [
  'received',
  'in_custody',
  'deposited',
  'cleared',
  'bounced',
  'endorsed',
  'returned',
  'cancelled',
  'issued',
] as const;
export type ChequeStatus = (typeof CHEQUE_STATUSES)[number];

const RECEIVED_TRANSITIONS: Readonly<Record<string, readonly ChequeStatus[]>> = {
  received: ['in_custody', 'endorsed', 'returned', 'cancelled'],
  in_custody: ['deposited', 'endorsed', 'returned', 'cancelled'],
  deposited: ['cleared', 'bounced'],
  cleared: ['bounced', 'returned'],
  bounced: [],
  endorsed: [],
  returned: [],
  cancelled: [],
};

const ISSUED_TRANSITIONS: Readonly<Record<string, readonly ChequeStatus[]>> = {
  issued: ['cleared', 'bounced', 'returned', 'cancelled'],
  cleared: ['bounced'],
  bounced: [],
  returned: [],
  cancelled: [],
};

/** Initial status is direction-dependent (`CK ck_cheques_initial_state`). */
export function initialChequeStatus(direction: ChequeDirection): ChequeStatus {
  return direction === 'issued' ? 'issued' : 'received';
}

export function allowedTransitions(
  direction: ChequeDirection,
  status: ChequeStatus,
): readonly ChequeStatus[] {
  const table = direction === 'issued' ? ISSUED_TRANSITIONS : RECEIVED_TRANSITIONS;
  return table[status] ?? [];
}

export function canTransition(
  direction: ChequeDirection,
  from: ChequeStatus,
  to: ChequeStatus,
): boolean {
  return allowedTransitions(direction, from).includes(to);
}

/** Throws `RULE_VIOLATION` for any undocumented transition. */
export function assertChequeTransition(
  direction: ChequeDirection,
  from: ChequeStatus,
  to: ChequeStatus,
): void {
  if (!canTransition(direction, from, to)) {
    throw new AppError('RULE_VIOLATION', {
      details: [
        {
          rule: 'cheque_transition_invalid',
          params: { direction, from, to },
        },
      ],
      message: `گذار وضعیت چک از «${from}» به «${to}» مجاز نیست.`,
    });
  }
}

export interface ChequeAccountingEvent {
  readonly eventType:
    | 'cheque.received'
    | 'cheque.deposited'
    | 'cheque.cleared'
    | 'cheque.issued.cleared'
    | 'cheque.bounced'
    | 'cheque.endorsed'
    | 'cheque.issued';
  readonly afterClear: boolean;
}

/**
 * Maps a state transition to the accounting event that must be posted in the
 * same transaction. Cancellation is an accounting reversal of the registration.
 */
export function accountingEventFor(
  direction: ChequeDirection,
  from: ChequeStatus,
  to: ChequeStatus,
): ChequeAccountingEvent {
  assertChequeTransition(direction, from, to);
  switch (to) {
    case 'in_custody':
      return { eventType: direction === 'issued' ? 'cheque.issued' : 'cheque.received', afterClear: false };
    case 'deposited':
      return { eventType: 'cheque.deposited', afterClear: false };
    case 'cleared':
      return {
        eventType: direction === 'issued' ? 'cheque.issued.cleared' : 'cheque.cleared',
        afterClear: true,
      };
    case 'bounced':
      return { eventType: 'cheque.bounced', afterClear: from === 'cleared' };
    case 'endorsed':
      return { eventType: 'cheque.endorsed', afterClear: false };
    case 'returned':
      return { eventType: 'cheque.bounced', afterClear: from === 'cleared' };
    case 'cancelled':
      // cancelling a registered cheque reverses its registration entry
      return { eventType: 'cheque.bounced', afterClear: false };
    case 'received':
      return { eventType: 'cheque.received', afterClear: false };
    case 'issued':
      return { eventType: 'cheque.issued', afterClear: false };
    default:
      throw new AppError('RULE_VIOLATION', { details: [{ rule: 'cheque_transition_unknown' }] });
  }
}

/** Whether a transition is a value-moving lifecycle event (needs an amount). */
export function requiresAmount(to: ChequeStatus): boolean {
  return to !== 'in_custody';
}
