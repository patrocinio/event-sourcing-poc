import { createEvent, DomainEvent, EventTypes } from '../src/domain/events';
import {
  LoanRow,
  fromDbRow,
  projectAll,
  projectEvent,
  toLoanView,
} from '../src/shared/loan-projection';

const ID = 'loan-1';

function ev(
  version: number,
  eventType: string,
  payload: Record<string, unknown>,
  timestamp: string
): DomainEvent {
  return { ...createEvent(ID, version, eventType, payload), timestamp };
}

const submitted = ev(
  1,
  EventTypes.LOAN_APPLICATION_SUBMITTED,
  { applicantName: 'Alice', requestedAmount: 50000, purpose: 'Home' },
  '2024-01-01T00:00:00.000Z'
);
const approved = ev(
  2,
  EventTypes.LOAN_APPROVED,
  { approvedAmount: 45000, approvedBy: 'Manager' },
  '2024-01-02T00:00:00.000Z'
);
const rejected = ev(
  2,
  EventTypes.LOAN_REJECTED,
  { reason: 'Too risky', rejectedBy: 'Risk Engine' },
  '2024-01-02T00:00:00.000Z'
);
const disbursed = ev(
  3,
  EventTypes.LOAN_DISBURSED,
  { disbursementAccount: 'ACH-123' },
  '2024-01-03T00:00:00.000Z'
);

function apply(events: DomainEvent[]): LoanRow | null {
  let row: LoanRow | null = null;
  for (const e of events) row = projectEvent(row, e) ?? row;
  return row;
}

describe('Loan projection (event -> loans row)', () => {
  it('creates a SUBMITTED row from LoanApplicationSubmitted', () => {
    const row = projectEvent(null, submitted)!;
    expect(row).toEqual({
      loan_id: ID,
      applicant_name: 'Alice',
      requested_amount: 50000,
      purpose: 'Home',
      status: 'SUBMITTED',
      approved_amount: null,
      approved_by: null,
      approved_at: null,
      rejection_reason: null,
      rejected_by: null,
      disbursement_account: null,
      disbursed_at: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      last_version: 1,
    });
  });

  it('sets APPROVED with amount, approver and timestamp', () => {
    const row = apply([submitted, approved])!;
    expect(row.status).toBe('APPROVED');
    expect(row.approved_amount).toBe(45000);
    expect(row.approved_by).toBe('Manager');
    expect(row.approved_at).toBe('2024-01-02T00:00:00.000Z');
    expect(row.applicant_name).toBe('Alice'); // prior fields preserved
    expect(row.created_at).toBe('2024-01-01T00:00:00.000Z');
    expect(row.last_version).toBe(2);
  });

  it('sets REJECTED with reason and rejector', () => {
    const row = apply([submitted, rejected])!;
    expect(row.status).toBe('REJECTED');
    expect(row.rejection_reason).toBe('Too risky');
    expect(row.rejected_by).toBe('Risk Engine');
    expect(row.last_version).toBe(2);
  });

  it('sets DISBURSED with account and timestamp', () => {
    const row = apply([submitted, approved, disbursed])!;
    expect(row.status).toBe('DISBURSED');
    expect(row.disbursement_account).toBe('ACH-123');
    expect(row.disbursed_at).toBe('2024-01-03T00:00:00.000Z');
    expect(row.approved_by).toBe('Manager');
    expect(row.last_version).toBe(3);
  });

  it('ignores a duplicate delivery of the same version', () => {
    const row = apply([submitted, approved])!;
    expect(projectEvent(row, approved)).toBeNull();
    expect(projectEvent(row, { ...approved, payload: { approvedAmount: 1, approvedBy: 'X' } })).toBeNull();
  });

  it('ignores an out-of-order (stale) event with version <= last_version', () => {
    const row = apply([submitted, approved, disbursed])!;
    expect(projectEvent(row, approved)).toBeNull(); // v2 after v3
    expect(projectEvent(row, submitted)).toBeNull(); // v1 after v3
    expect(apply([submitted, approved, disbursed, approved])!.status).toBe('DISBURSED');
  });

  it('ignores follow-up events for a loan that has no projected row', () => {
    expect(projectEvent(null, approved)).toBeNull();
    expect(projectEvent(null, rejected)).toBeNull();
    expect(projectEvent(null, disbursed)).toBeNull();
  });

  it('ignores unknown event types', () => {
    const row = projectEvent(null, submitted)!;
    expect(projectEvent(row, ev(2, 'SomethingElse', {}, '2024-01-05T00:00:00.000Z'))).toBeNull();
  });

  it('is deterministic: replaying the full stream twice yields the same row', () => {
    const stream = [submitted, approved, disbursed];
    expect(apply([...stream, ...stream])).toEqual(apply(stream));
  });
});

describe('projectAll (full history -> loans row, order-insensitive)', () => {
  const full = [submitted, approved, disbursed];

  it('returns null for an empty history', () => {
    expect(projectAll([])).toBeNull();
  });

  it('folds an in-order history the same as sequential projectEvent', () => {
    expect(projectAll(full)).toEqual(apply(full));
    expect(projectAll(full)!.status).toBe('DISBURSED');
    expect(projectAll(full)!.last_version).toBe(3);
  });

  it('produces the same row for every permutation of the history', () => {
    const expected = apply(full);
    const permutations = [
      [submitted, approved, disbursed],
      [submitted, disbursed, approved],
      [approved, submitted, disbursed],
      [approved, disbursed, submitted],
      [disbursed, submitted, approved],
      [disbursed, approved, submitted],
    ];
    for (const p of permutations) expect(projectAll(p)).toEqual(expected);
  });

  it('ignores duplicate deliveries of the same version', () => {
    const withDupes = [disbursed, approved, submitted, approved, disbursed, submitted];
    expect(projectAll(withDupes)).toEqual(apply(full));
  });

  it('keeps the first event for a duplicated version and ignores the conflicting one', () => {
    const row = projectAll([submitted, approved, rejected])!; // two different v2s
    expect(row.status).toBe('APPROVED');
    expect(row.last_version).toBe(2);
    expect(row.rejection_reason).toBeNull();
  });

  it('projects a partial history (gap-free prefix) up to the latest version', () => {
    const row = projectAll([approved, submitted])!;
    expect(row.status).toBe('APPROVED');
    expect(row.last_version).toBe(2);
  });

  it('returns null when the submission event is missing', () => {
    expect(projectAll([approved, disbursed])).toBeNull();
  });

  it('does not mutate its input', () => {
    const input = [disbursed, submitted, approved];
    const copy = [...input];
    projectAll(input);
    expect(input).toEqual(copy);
  });
});

describe('Loan view (row -> API JSON)', () => {
  it('matches the previous Redis view shape for a submitted loan', () => {
    const view = toLoanView(projectEvent(null, submitted)!);
    expect(view).toEqual({
      loanId: ID,
      applicantName: 'Alice',
      requestedAmount: 50000,
      purpose: 'Home',
      status: 'SUBMITTED',
      submittedAt: '2024-01-01T00:00:00.000Z',
      approvedAmount: null,
      approvedBy: null,
      approvedAt: null,
      rejectedReason: null,
      rejectedBy: null,
      disbursedAt: null,
    });
    expect(view).not.toHaveProperty('disbursementAccount');
  });

  it('includes disbursementAccount once disbursed', () => {
    const view = toLoanView(apply([submitted, approved, disbursed])!);
    expect(view.disbursementAccount).toBe('ACH-123');
    expect(view.disbursedAt).toBe('2024-01-03T00:00:00.000Z');
  });

  it('normalizes node-postgres types (numeric strings, Date timestamps)', () => {
    const row = fromDbRow({
      loan_id: ID,
      applicant_name: 'Alice',
      requested_amount: '50000',
      purpose: 'Home',
      status: 'APPROVED',
      approved_amount: '45000.50',
      approved_by: 'Manager',
      approved_at: new Date('2024-01-02T00:00:00.000Z'),
      rejection_reason: null,
      rejected_by: null,
      disbursement_account: null,
      disbursed_at: null,
      created_at: new Date('2024-01-01T00:00:00.000Z'),
      updated_at: new Date('2024-01-02T00:00:00.000Z'),
      last_version: 2,
    });
    const view = toLoanView(row);
    expect(view.requestedAmount).toBe(50000);
    expect(view.approvedAmount).toBe(45000.5);
    expect(view.submittedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(view.approvedAt).toBe('2024-01-02T00:00:00.000Z');
  });
});
