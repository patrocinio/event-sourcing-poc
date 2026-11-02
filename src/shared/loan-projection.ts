/**
 * Loan read-model projection — pure functions, no I/O.
 *
 * - projectEvent: (current row, event) -> next row | null (null = no change)
 * - toLoanView:   row -> API JSON (same field names the Redis read model used)
 *
 * Idempotency: an event whose version is <= the row's last_version has already
 * been applied (Kinesis is at-least-once) and is ignored. The SQL upsert in the
 * projector carries the same guard so concurrent/replayed writes are also safe.
 */
import { DomainEvent, EventTypes } from '../domain/events';

/** One row of the `loans` table. Timestamps are ISO-8601 strings. */
export interface LoanRow {
  loan_id: string;
  applicant_name: string | null;
  requested_amount: number | null;
  purpose: string | null;
  status: string;
  approved_amount: number | null;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  rejected_by: string | null;
  disbursement_account: string | null;
  disbursed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_version: number;
}

/** API response shape (identical to the previous Redis loan view). */
export interface LoanView {
  loanId: string;
  applicantName: string | null;
  requestedAmount: number | null;
  purpose: string | null;
  status: string;
  submittedAt: string | null;
  approvedAmount: number | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  rejectedBy: string | null;
  disbursedAt: string | null;
  disbursementAccount?: string;
}

/**
 * Apply one event to the current projection row.
 * Returns the new row, or null when the event must not change the projection
 * (duplicate/stale version, unknown type, or a follow-up event for a loan
 * whose submission has not been projected — same as the Redis projector).
 */
export function projectEvent(current: LoanRow | null, event: DomainEvent): LoanRow | null {
  if (current && event.version <= current.last_version) return null;

  const p = event.payload;
  switch (event.eventType) {
    case EventTypes.LOAN_APPLICATION_SUBMITTED:
      if (current) return null; // submission is always the first event
      return {
        loan_id: event.aggregateId,
        applicant_name: (p.applicantName as string) ?? null,
        requested_amount: (p.requestedAmount as number) ?? null,
        purpose: (p.purpose as string) ?? null,
        status: 'SUBMITTED',
        approved_amount: null,
        approved_by: null,
        approved_at: null,
        rejection_reason: null,
        rejected_by: null,
        disbursement_account: null,
        disbursed_at: null,
        created_at: event.timestamp,
        updated_at: event.timestamp,
        last_version: event.version,
      };

    case EventTypes.LOAN_APPROVED:
      if (!current) return null;
      return {
        ...current,
        status: 'APPROVED',
        approved_amount: (p.approvedAmount as number) ?? null,
        approved_by: (p.approvedBy as string) ?? null,
        approved_at: event.timestamp,
        updated_at: event.timestamp,
        last_version: event.version,
      };

    case EventTypes.LOAN_REJECTED:
      if (!current) return null;
      return {
        ...current,
        status: 'REJECTED',
        rejection_reason: (p.reason as string) ?? null,
        rejected_by: (p.rejectedBy as string) ?? null,
        updated_at: event.timestamp,
        last_version: event.version,
      };

    case EventTypes.LOAN_DISBURSED:
      if (!current) return null;
      return {
        ...current,
        status: 'DISBURSED',
        disbursement_account: (p.disbursementAccount as string) ?? null,
        disbursed_at: event.timestamp,
        updated_at: event.timestamp,
        last_version: event.version,
      };

    default:
      return null;
  }
}

/** Raw row as returned by node-postgres (numeric -> string, timestamptz -> Date). */
export type DbLoanRow = Record<string, unknown>;

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toStr(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** Normalize a node-postgres row into a LoanRow. */
export function fromDbRow(r: DbLoanRow): LoanRow {
  return {
    loan_id: String(r.loan_id),
    applicant_name: toStr(r.applicant_name),
    requested_amount: toNumber(r.requested_amount),
    purpose: toStr(r.purpose),
    status: String(r.status),
    approved_amount: toNumber(r.approved_amount),
    approved_by: toStr(r.approved_by),
    approved_at: toIso(r.approved_at),
    rejection_reason: toStr(r.rejection_reason),
    rejected_by: toStr(r.rejected_by),
    disbursement_account: toStr(r.disbursement_account),
    disbursed_at: toIso(r.disbursed_at),
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
    last_version: Number(r.last_version),
  };
}

/** Map a projection row to the public API JSON shape. */
export function toLoanView(row: LoanRow): LoanView {
  const view: LoanView = {
    loanId: row.loan_id,
    applicantName: row.applicant_name,
    requestedAmount: row.requested_amount,
    purpose: row.purpose,
    status: row.status,
    submittedAt: row.created_at,
    approvedAmount: row.approved_amount,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedReason: row.rejection_reason,
    rejectedBy: row.rejected_by,
    disbursedAt: row.disbursed_at,
  };
  // The Redis view only carried disbursementAccount once a loan was disbursed.
  if (row.disbursement_account !== null) view.disbursementAccount = row.disbursement_account;
  return view;
}
