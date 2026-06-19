# API Documentation

## REST APIs

### Submit Loan Application
- **Method**: POST
- **Path**: `/api/loans`
- **Purpose**: Create a new loan application
- **Request**:
  ```json
  {
    "applicantName": "string",
    "requestedAmount": "decimal",
    "purpose": "string"
  }
  ```
- **Response** (201 Created):
  ```json
  {
    "loanId": "uuid-string",
    "status": "SUBMITTED"
  }
  ```

### Approve Loan
- **Method**: POST
- **Path**: `/api/loans/{loanId}/approve`
- **Purpose**: Approve a submitted loan application
- **Request**:
  ```json
  {
    "approvedAmount": "decimal",
    "approvedBy": "string"
  }
  ```
- **Response** (200 OK):
  ```json
  {
    "loanId": "uuid-string",
    "status": "APPROVED"
  }
  ```

### Reject Loan
- **Method**: POST
- **Path**: `/api/loans/{loanId}/reject`
- **Purpose**: Reject a submitted loan application
- **Request**:
  ```json
  {
    "reason": "string",
    "rejectedBy": "string"
  }
  ```
- **Response** (200 OK):
  ```json
  {
    "loanId": "uuid-string",
    "status": "REJECTED"
  }
  ```

### Disburse Loan
- **Method**: POST
- **Path**: `/api/loans/{loanId}/disburse`
- **Purpose**: Disburse an approved loan to a bank account
- **Request**:
  ```json
  {
    "disbursementAccount": "string"
  }
  ```
- **Response** (200 OK):
  ```json
  {
    "loanId": "uuid-string",
    "status": "DISBURSED"
  }
  ```

### Get All Loans
- **Method**: GET
- **Path**: `/api/loans`
- **Purpose**: Retrieve all loan applications sorted by submission date (newest first)
- **Request**: None
- **Response** (200 OK):
  ```json
  [
    {
      "loanId": "string",
      "applicantName": "string",
      "requestedAmount": "decimal",
      "status": "string",
      "purpose": "string",
      "submittedAt": "ISO-8601",
      "approvedAmount": "decimal|null",
      "approvedBy": "string|null",
      "approvedAt": "ISO-8601|null",
      "rejectedReason": "string|null",
      "rejectedBy": "string|null",
      "disbursedAt": "ISO-8601|null"
    }
  ]
  ```

### Get Loan by ID
- **Method**: GET
- **Path**: `/api/loans/{loanId}`
- **Purpose**: Retrieve a specific loan by its ID
- **Request**: None
- **Response** (200 OK): Same as single item from Get All Loans

### Get Loans by Status
- **Method**: GET
- **Path**: `/api/loans/status/{status}`
- **Purpose**: Filter loans by status (SUBMITTED, APPROVED, REJECTED, DISBURSED)
- **Request**: None
- **Response** (200 OK): Array of loan summary objects

## Internal APIs

### Command Messages
- `SubmitLoanApplicationCommand(loanId, applicantName, requestedAmount, purpose)`
- `ApproveLoanCommand(loanId, approvedAmount, approvedBy)`
- `RejectLoanCommand(loanId, reason, rejectedBy)`
- `DisburseLoanCommand(loanId, disbursementAccount)`

### Event Messages
- `LoanApplicationSubmittedEvent(loanId, applicantName, requestedAmount, purpose, submittedAt)`
- `LoanApprovedEvent(loanId, approvedAmount, approvedBy, approvedAt)`
- `LoanRejectedEvent(loanId, reason, rejectedBy, rejectedAt)`
- `LoanDisbursedEvent(loanId, disbursementAccount, disbursedAt)`

### Query Messages
- `FindLoanByIdQuery(loanId)` → `LoanSummaryView?`
- `FindAllLoansQuery(limit=50)` → `List<LoanSummaryView>`
- `FindLoansByStatusQuery(status)` → `List<LoanSummaryView>`

## Data Models

### LoanSummaryView (Read Model)
- **Fields**:
  - `loanId: String` — Unique identifier
  - `applicantName: String` — Name of the applicant
  - `requestedAmount: BigDecimal` — Amount requested
  - `status: String` — Current status (SUBMITTED/APPROVED/REJECTED/DISBURSED)
  - `purpose: String` — Loan purpose
  - `submittedAt: Instant` — Submission timestamp
  - `approvedAmount: BigDecimal?` — Approved amount (if approved)
  - `approvedBy: String?` — Approver name
  - `approvedAt: Instant?` — Approval timestamp
  - `rejectedReason: String?` — Rejection reason
  - `rejectedBy: String?` — Rejector name
  - `disbursedAt: Instant?` — Disbursement timestamp
- **Relationships**: One-to-one with LoanAggregate (same loanId)
- **Validation**: Amount must be positive, status transitions enforced by aggregate

### LoanStatus (Enum)
- `SUBMITTED` — Initial state after application
- `APPROVED` — Loan approved (from SUBMITTED only)
- `REJECTED` — Loan rejected (from SUBMITTED only)
- `DISBURSED` — Funds disbursed (from APPROVED only)
