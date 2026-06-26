import { rehydrate, validateCommand, LoanStatus } from '../src/domain/aggregate';
import { createEvent, EventTypes } from '../src/domain/events';

describe('Loan Aggregate', () => {
  describe('rehydrate', () => {
    it('should return empty state for no events', () => {
      const state = rehydrate([]);
      expect(state.status).toBeNull();
      expect(state.version).toBe(0);
    });

    it('should set SUBMITTED status after LoanApplicationSubmitted', () => {
      const events = [
        createEvent('loan-1', 1, EventTypes.LOAN_APPLICATION_SUBMITTED, {
          applicantName: 'Alice',
          requestedAmount: 50000,
          purpose: 'Home',
        }),
      ];
      const state = rehydrate(events);
      expect(state.status).toBe(LoanStatus.SUBMITTED);
      expect(state.applicantName).toBe('Alice');
      expect(state.requestedAmount).toBe(50000);
      expect(state.version).toBe(1);
    });

    it('should set APPROVED status after LoanApproved', () => {
      const events = [
        createEvent('loan-1', 1, EventTypes.LOAN_APPLICATION_SUBMITTED, {
          applicantName: 'Alice',
          requestedAmount: 50000,
          purpose: 'Home',
        }),
        createEvent('loan-1', 2, EventTypes.LOAN_APPROVED, {
          approvedAmount: 45000,
          approvedBy: 'Manager',
        }),
      ];
      const state = rehydrate(events);
      expect(state.status).toBe(LoanStatus.APPROVED);
      expect(state.approvedAmount).toBe(45000);
      expect(state.approvedBy).toBe('Manager');
      expect(state.version).toBe(2);
    });

    it('should set REJECTED status after LoanRejected', () => {
      const events = [
        createEvent('loan-1', 1, EventTypes.LOAN_APPLICATION_SUBMITTED, {
          applicantName: 'Bob',
          requestedAmount: 1000000,
          purpose: 'Speculation',
        }),
        createEvent('loan-1', 2, EventTypes.LOAN_REJECTED, {
          reason: 'Too risky',
          rejectedBy: 'Risk Engine',
        }),
      ];
      const state = rehydrate(events);
      expect(state.status).toBe(LoanStatus.REJECTED);
      expect(state.rejectedReason).toBe('Too risky');
    });

    it('should set DISBURSED status after full lifecycle', () => {
      const events = [
        createEvent('loan-1', 1, EventTypes.LOAN_APPLICATION_SUBMITTED, {
          applicantName: 'Carol',
          requestedAmount: 75000,
          purpose: 'Business',
        }),
        createEvent('loan-1', 2, EventTypes.LOAN_APPROVED, {
          approvedAmount: 70000,
          approvedBy: 'VP',
        }),
        createEvent('loan-1', 3, EventTypes.LOAN_DISBURSED, {
          disbursementAccount: 'ACH-123',
        }),
      ];
      const state = rehydrate(events);
      expect(state.status).toBe(LoanStatus.DISBURSED);
      expect(state.disbursementAccount).toBe('ACH-123');
      expect(state.version).toBe(3);
    });
  });

  describe('validateCommand', () => {
    it('should allow SubmitLoan with no prior state', () => {
      const state = rehydrate([]);
      expect(validateCommand(state, 'SubmitLoan')).toBeNull();
    });

    it('should allow ApproveLoan when SUBMITTED', () => {
      const events = [
        createEvent('loan-1', 1, EventTypes.LOAN_APPLICATION_SUBMITTED, {
          applicantName: 'A',
          requestedAmount: 100,
          purpose: 'X',
        }),
      ];
      const state = rehydrate(events);
      expect(validateCommand(state, 'ApproveLoan')).toBeNull();
    });

    it('should reject ApproveLoan when APPROVED', () => {
      const events = [
        createEvent('loan-1', 1, EventTypes.LOAN_APPLICATION_SUBMITTED, {
          applicantName: 'A',
          requestedAmount: 100,
          purpose: 'X',
        }),
        createEvent('loan-1', 2, EventTypes.LOAN_APPROVED, {
          approvedAmount: 100,
          approvedBy: 'B',
        }),
      ];
      const state = rehydrate(events);
      const error = validateCommand(state, 'ApproveLoan');
      expect(error).toContain('Can only approve a SUBMITTED loan');
    });

    it('should reject DisburseLoan when SUBMITTED', () => {
      const events = [
        createEvent('loan-1', 1, EventTypes.LOAN_APPLICATION_SUBMITTED, {
          applicantName: 'A',
          requestedAmount: 100,
          purpose: 'X',
        }),
      ];
      const state = rehydrate(events);
      const error = validateCommand(state, 'DisburseLoan');
      expect(error).toContain('Can only disburse an APPROVED loan');
    });

    it('should allow DisburseLoan when APPROVED', () => {
      const events = [
        createEvent('loan-1', 1, EventTypes.LOAN_APPLICATION_SUBMITTED, {
          applicantName: 'A',
          requestedAmount: 100,
          purpose: 'X',
        }),
        createEvent('loan-1', 2, EventTypes.LOAN_APPROVED, {
          approvedAmount: 100,
          approvedBy: 'B',
        }),
      ];
      const state = rehydrate(events);
      expect(validateCommand(state, 'DisburseLoan')).toBeNull();
    });
  });
});
