/**
 * Loan Aggregate — reconstructs state from events and validates commands.
 *
 * This is the core CQRS/Event Sourcing pattern:
 * - State is NEVER stored directly
 * - State is computed by replaying events in order
 * - Commands are validated against computed state
 * - Valid commands produce new events
 */

import { DomainEvent, EventTypes } from './events';

export enum LoanStatus {
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  DISBURSED = 'DISBURSED',
}

export interface LoanState {
  loanId: string;
  status: LoanStatus | null;
  applicantName?: string;
  requestedAmount?: number;
  purpose?: string;
  approvedAmount?: number;
  approvedBy?: string;
  approvedAt?: string;
  rejectedReason?: string;
  rejectedBy?: string;
  disbursedAt?: string;
  disbursementAccount?: string;
  submittedAt?: string;
  version: number;
}

/**
 * Rehydrate aggregate state by replaying events in order.
 * This is the fundamental event sourcing operation: state = f(events)
 */
export function rehydrate(events: DomainEvent[]): LoanState {
  let state: LoanState = { loanId: '', status: null, version: 0 };

  for (const event of events) {
    state = applyEvent(state, event);
  }

  return state;
}

function applyEvent(state: LoanState, event: DomainEvent): LoanState {
  switch (event.eventType) {
    case EventTypes.LOAN_APPLICATION_SUBMITTED:
      return {
        ...state,
        loanId: event.aggregateId,
        status: LoanStatus.SUBMITTED,
        applicantName: event.payload.applicantName as string,
        requestedAmount: event.payload.requestedAmount as number,
        purpose: event.payload.purpose as string,
        submittedAt: event.timestamp,
        version: event.version,
      };

    case EventTypes.LOAN_APPROVED:
      return {
        ...state,
        status: LoanStatus.APPROVED,
        approvedAmount: event.payload.approvedAmount as number,
        approvedBy: event.payload.approvedBy as string,
        approvedAt: event.timestamp,
        version: event.version,
      };

    case EventTypes.LOAN_REJECTED:
      return {
        ...state,
        status: LoanStatus.REJECTED,
        rejectedReason: event.payload.reason as string,
        rejectedBy: event.payload.rejectedBy as string,
        version: event.version,
      };

    case EventTypes.LOAN_DISBURSED:
      return {
        ...state,
        status: LoanStatus.DISBURSED,
        disbursementAccount: event.payload.disbursementAccount as string,
        disbursedAt: event.timestamp,
        version: event.version,
      };

    default:
      return state;
  }
}

/**
 * Validate a command against current aggregate state.
 * Returns null if valid, or an error message if invalid.
 */
export function validateCommand(
  state: LoanState,
  command: string
): string | null {
  switch (command) {
    case 'SubmitLoan':
      // Creation command — always valid (no prior state)
      return null;

    case 'ApproveLoan':
      if (state.status !== LoanStatus.SUBMITTED) {
        return `Can only approve a SUBMITTED loan (current: ${state.status})`;
      }
      return null;

    case 'RejectLoan':
      if (state.status !== LoanStatus.SUBMITTED) {
        return `Can only reject a SUBMITTED loan (current: ${state.status})`;
      }
      return null;

    case 'DisburseLoan':
      if (state.status !== LoanStatus.APPROVED) {
        return `Can only disburse an APPROVED loan (current: ${state.status})`;
      }
      return null;

    default:
      return `Unknown command: ${command}`;
  }
}
