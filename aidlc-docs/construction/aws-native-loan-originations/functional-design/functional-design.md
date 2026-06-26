# Functional Design — AWS-Native Loan Originations

## 1. Domain Events

All events are immutable facts stored in DynamoDB. Each event includes metadata for ordering and replay.

```typescript
interface DomainEvent {
  aggregateId: string;       // Loan ID (partition key)
  version: number;           // Sequence within aggregate (sort key)
  eventType: string;         // Discriminator
  timestamp: string;         // ISO 8601
  payload: Record<string, any>;
}
```

### Event Types:

| Event | Payload Fields |
|-------|---------------|
| LoanApplicationSubmitted | applicantName, requestedAmount, purpose |
| LoanApproved | approvedAmount, approvedBy |
| LoanRejected | reason, rejectedBy |
| LoanDisbursed | disbursementAccount |

## 2. DynamoDB Table Schemas

### Event Store Table: `LoanEvents`

| Attribute | Type | Key |
|-----------|------|-----|
| aggregateId | S | Partition Key |
| version | N | Sort Key |
| eventType | S | Attribute |
| timestamp | S | Attribute |
| payload | M | Attribute |

- **DynamoDB Streams** enabled (NEW_IMAGE) for projection updates

### Read Model: ElastiCache (Redis)

| Key Pattern | Value |
|-------------|-------|
| `loan:{id}` | JSON of full loan state |
| `loans:all` | Sorted set (score = timestamp, member = loan ID) |
| `loans:status:{status}` | Set of loan IDs with that status |

## 3. Aggregate Logic (Loan Aggregate)

The aggregate is reconstructed by replaying events from DynamoDB:

```
function rehydrate(events: DomainEvent[]): LoanState
  state = { status: null }
  for each event in events (ordered by version):
    switch event.eventType:
      LoanApplicationSubmitted → state = { status: SUBMITTED, ...payload }
      LoanApproved → state = { ...state, status: APPROVED, ...payload }
      LoanRejected → state = { ...state, status: REJECTED, ...payload }
      LoanDisbursed → state = { ...state, status: DISBURSED, ...payload }
  return state
```

### Business Rules (enforced in Command Lambda):

| Command | Precondition | Event Emitted |
|---------|-------------|---------------|
| SubmitLoan | (none — creation) | LoanApplicationSubmitted |
| ApproveLoan | status == SUBMITTED | LoanApproved |
| RejectLoan | status == SUBMITTED | LoanRejected |
| DisburseLoan | status == APPROVED | LoanDisbursed |

## 4. Command Flow (Write Path)

```
API Gateway POST /api/loans/{id}/approve
    │
    ▼
Command Lambda:
    1. Read all events for aggregateId from DynamoDB (Query)
    2. Replay events → current state
    3. Validate preconditions (status == SUBMITTED)
    4. If invalid → return 409 Conflict
    5. Compute next version = events.length + 1
    6. PutItem to DynamoDB with condition: attribute_not_exists(version)
       (optimistic concurrency — prevents duplicate writes)
    7. Put record to Kinesis (for downstream consumers)
    8. Return 200 OK with new status
```

### Optimistic Concurrency:
- DynamoDB conditional write ensures no two commands produce the same version
- If condition fails → retry with fresh state (or return 409)

## 5. Query Flow (Read Path)

```
API Gateway GET /api/loans/{id}
    │
    ▼
Query Lambda:
    1. GET loan:{id} from Redis
    2. Return JSON response (or 404 if not found)
```

```
API Gateway GET /api/loans
    │
    ▼
Query Lambda:
    1. ZREVRANGE loans:all 0 49 from Redis (get latest 50 loan IDs)
    2. MGET loan:{id1} loan:{id2} ... from Redis
    3. Return JSON array
```

## 6. Projection Flow (Event → Read Model)

```
DynamoDB Streams (LoanEvents table)
    │
    ▼
Projector Lambda:
    1. Parse stream record (NEW_IMAGE)
    2. Extract event fields
    3. Update Redis:
       - SET loan:{id} → full loan JSON
       - ZADD loans:all timestamp loanId
       - SADD loans:status:{newStatus} loanId
       - SREM loans:status:{oldStatus} loanId (if status changed)
```

## 7. API Endpoints

| Method | Path | Lambda | Description |
|--------|------|--------|-------------|
| POST | /api/loans | commandHandler | Submit new loan |
| POST | /api/loans/{id}/approve | commandHandler | Approve loan |
| POST | /api/loans/{id}/reject | commandHandler | Reject loan |
| POST | /api/loans/{id}/disburse | commandHandler | Disburse loan |
| GET | /api/loans | queryHandler | List all loans |
| GET | /api/loans/{id} | queryHandler | Get loan by ID |
| GET | /api/loans/status/{status} | queryHandler | Get loans by status |
| GET | /api/loans/health | healthHandler | Health check |

## 8. Error Handling

| Scenario | HTTP Status | Response |
|----------|-------------|----------|
| Missing required field | 400 | `{"error": "applicantName is required"}` |
| Invalid state transition | 409 | `{"error": "Can only approve SUBMITTED loans"}` |
| Loan not found | 404 | `{"error": "Loan not found"}` |
| Concurrent modification | 409 | `{"error": "Concurrent modification, retry"}` |
| Internal error | 500 | `{"error": "Internal server error"}` |

---

**Functional Design Complete.**

A) Continue to Infrastructure Design

B) Request Changes

[Answer]: 
