/**
 * Domain Events — immutable facts stored in the event store.
 * These are the source of truth for all state in the system.
 */

export interface DomainEvent {
  aggregateId: string;
  version: number;
  eventType: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export const EventTypes = {
  LOAN_APPLICATION_SUBMITTED: 'LoanApplicationSubmitted',
  LOAN_APPROVED: 'LoanApproved',
  LOAN_REJECTED: 'LoanRejected',
  LOAN_DISBURSED: 'LoanDisbursed',
} as const;

export interface LoanApplicationSubmittedPayload {
  applicantName: string;
  requestedAmount: number;
  purpose: string;
}

export interface LoanApprovedPayload {
  approvedAmount: number;
  approvedBy: string;
}

export interface LoanRejectedPayload {
  reason: string;
  rejectedBy: string;
}

export interface LoanDisbursedPayload {
  disbursementAccount: string;
}

export function createEvent(
  aggregateId: string,
  version: number,
  eventType: string,
  payload: Record<string, unknown>
): DomainEvent {
  return {
    aggregateId,
    version,
    eventType,
    timestamp: new Date().toISOString(),
    payload,
  };
}
