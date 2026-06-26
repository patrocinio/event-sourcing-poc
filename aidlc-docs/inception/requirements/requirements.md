# Requirements — AWS-Native Loan Originations (CQRS/Event Sourcing)

## 1. Overview

Reimplement the Axon Framework Loan Originations PoC using native AWS services. The solution must demonstrate the same CQRS (Command Query Responsibility Segregation) and Event Sourcing patterns using fully managed AWS infrastructure — no third-party frameworks.

## 2. Functional Requirements

### FR-1: Loan Application Submission
- Accept loan application via REST API (POST /api/loans)
- Validate business rules (amount > 0, required fields)
- Generate unique loan ID
- Persist LoanApplicationSubmittedEvent to event store
- Return loan ID and status

### FR-2: Loan Approval
- Accept approval command via REST API (POST /api/loans/{id}/approve)
- Enforce state machine: only SUBMITTED loans can be approved
- Persist LoanApprovedEvent to event store
- Return updated status

### FR-3: Loan Rejection
- Accept rejection command via REST API (POST /api/loans/{id}/reject)
- Enforce state machine: only SUBMITTED loans can be rejected
- Persist LoanRejectedEvent to event store
- Return updated status

### FR-4: Loan Disbursement
- Accept disbursement command via REST API (POST /api/loans/{id}/disburse)
- Enforce state machine: only APPROVED loans can be disbursed
- Persist LoanDisbursedEvent to event store
- Return updated status

### FR-5: Query All Loans
- Query all loans via GET /api/loans
- Read from projection (read model), not event store
- Return list sorted by submission date descending

### FR-6: Query Loan by ID
- Query single loan via GET /api/loans/{id}
- Read from projection (read model)
- Return full loan state including timestamps

### FR-7: Query Loans by Status
- Query loans filtered by status via GET /api/loans/status/{status}
- Read from projection (read model)

### FR-8: Event Sourcing — State Reconstruction
- Aggregate state must be reconstructable from event stream
- Events are immutable and append-only
- No direct state mutations in the event store

### FR-9: CQRS Separation
- Command side (write) and Query side (read) must be separate
- Read model updated asynchronously from events
- Commands validated against reconstructed aggregate state

## 3. Non-Functional Requirements

### NFR-1: Serverless Architecture
- All compute via AWS Lambda (TypeScript/Node.js)
- No servers or containers to manage
- Pay-per-use pricing model

### NFR-2: Event Store
- Kinesis Data Streams for ordered event streaming
- DynamoDB for durable event persistence
- Events ordered per aggregate (partition key = aggregate ID)

### NFR-3: Read Model
- ElastiCache (Redis) for low-latency query responses
- Updated via DynamoDB Streams → Lambda projector
- Eventually consistent with write model

### NFR-4: API Layer
- API Gateway (REST API) with Lambda integration
- Request validation at API Gateway level
- Proper HTTP status codes (201 Created, 400 Bad Request, 409 Conflict, 404 Not Found)

### NFR-5: Infrastructure as Code
- AWS CDK (TypeScript) for all infrastructure
- Single `cdk deploy` to provision entire stack
- Environment parameterization (dev/staging/prod)

### NFR-6: CI/CD
- GitHub Actions workflow
- Build, test, and deploy on push to `aws-native` branch
- CDK diff on PR, deploy on merge

### NFR-7: Observability
- CloudWatch Logs for all Lambda functions
- CloudWatch Metrics for API latency and error rates
- X-Ray tracing for end-to-end request visibility

### NFR-8: Security
- IAM least-privilege for all Lambda roles
- API Gateway with API key or IAM auth (configurable)
- Encryption at rest (DynamoDB, ElastiCache, Kinesis)
- VPC for ElastiCache (private subnet)

## 4. Architecture Summary

```
┌──────────────┐     ┌────────────┐     ┌──────────────┐     ┌─────────────────┐
│  API Gateway │────▶│  Command   │────▶│   Kinesis    │────▶│   DynamoDB      │
│  (REST API)  │     │  Lambda    │     │ Data Stream  │     │  (Event Store)  │
└──────────────┘     └────────────┘     └──────────────┘     └────────┬────────┘
       │                                                              │
       │                                                    DynamoDB Streams
       │                                                              │
       │                                                              ▼
       │             ┌────────────┐                         ┌──────────────────┐
       │             │   Query    │◀────────────────────────│  Projector       │
       └────────────▶│   Lambda   │                         │  Lambda          │
                     └─────┬──────┘                         └──────────────────┘
                           │
                           ▼
                     ┌────────────┐
                     │ ElastiCache│
                     │  (Redis)   │
                     └────────────┘
```

### Command Flow:
1. API Gateway receives POST request
2. Command Lambda validates business rules by replaying events from DynamoDB
3. If valid, publishes new event to Kinesis Data Stream
4. Kinesis consumer Lambda persists event to DynamoDB (Event Store)

### Query Flow:
1. DynamoDB Streams trigger Projector Lambda on new events
2. Projector Lambda updates Redis read model
3. API Gateway receives GET request
4. Query Lambda reads from Redis and returns response

## 5. Technology Stack

| Component | AWS Service | Purpose |
|-----------|-------------|---------|
| API | API Gateway (REST) | HTTP endpoints |
| Compute | Lambda (Node.js 20) | Business logic |
| Event Bus | Kinesis Data Streams | Ordered event delivery |
| Event Store | DynamoDB | Durable event persistence |
| Read Model | ElastiCache (Redis) | Low-latency queries |
| Change Capture | DynamoDB Streams | Trigger projections |
| IaC | AWS CDK (TypeScript) | Infrastructure definition |
| CI/CD | GitHub Actions | Automated deployment |
| Observability | CloudWatch + X-Ray | Logs, metrics, tracing |
| Language | TypeScript | Lambda runtime |
