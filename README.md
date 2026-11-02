# Aurora Loan Originations — CQRS/Event Sourcing (`aurora` branch)

A serverless implementation of CQRS (Command Query Responsibility Segregation) and Event Sourcing on AWS, with **Aurora PostgreSQL Serverless v2** as both the event store and the read model. This branch is derived from `aws-native` (DynamoDB Global Tables + ElastiCache Redis) and is the AWS counterpart of the [Axon Framework PoC](https://github.com/patrocinio/axon-poc/tree/main) on `main`.

The domain logic (`src/domain`) and the REST API contract (paths, request bodies, response JSON and status codes) are unchanged from `aws-native`. The API now requires IAM (SigV4) authentication.

## Architecture

```
 Client (SigV4-signed)
        │
        ▼
┌───────────────────┐
│ API Gateway (IAM) │
│      + WAF        │
└───┬───────────┬───┘
    │ POST      │ GET
    ▼           ▼
┌─────────┐  ┌─────────┐
│ Command │  │  Query  │
│ Lambda  │  │ Lambda  │
└──┬───┬──┘  └────▲────┘
   │   │          │ SELECT loans
   │   │ INSERT   │ (reader endpoint)
   │   ▼ event    │
   │ ┌──────────────────┐ replication ┌──────────────────┐
   │ │  Aurora WRITER   │────────────▶│  Aurora READER   │
   │ │ events + loans   │             │ loans (queries)  │
   │ └────────▲─────────┘             └──────────────────┘
   │          │ upsert loans (guarded by last_version)
   │ publish  │
   ▼ (after   │
   commit)    │
┌─────────┐  ┌───────────┐
│ Kinesis │─▶│ Projector │
│ Stream  │  │  Lambda   │
└─────────┘  └───────────┘
```

- **Aurora writer instance** (cluster endpoint): the `events` table is the event store. Appends are plain `INSERT`s; the primary key `(aggregate_id, version)` provides optimistic concurrency, so a concurrent writer gets a unique violation (SQLSTATE 23505) and the API returns `409 {"error":"Concurrent modification, retry"}`. The projector also writes the `loans` projection here.
- **Aurora reader instance** (reader endpoint, `scaleWithWriter`): serves every query and the health check. It never sees command traffic.
- **Kinesis-driven projector**: the command handler publishes each event to Kinesis (partition key = loan ID) after the commit. The projector consumes the stream (TRIM_HORIZON, batch 25, bisect on error, 5 retries) and upserts `loans` idempotently.
- **IAM-authenticated API**: every method uses `AWS_IAM` authorization. Callers sign requests with SigV4 and need `execute-api:Invoke` on the API. CORS preflight (`OPTIONS`) mocks stay unauthenticated because browsers never sign preflights, and they return no data.
- **Schema migration**: a CDK custom resource runs idempotent DDL (`CREATE ... IF NOT EXISTS`) on the writer before any API Lambda is created. It re-runs whenever the DDL changes (hash of `src/migration/schema.ts`).

### Schema

```sql
events(aggregate_id text, version integer, event_type text,
       occurred_at timestamptz, payload jsonb,
       PRIMARY KEY (aggregate_id, version))        -- + index on occurred_at

loans(loan_id text PRIMARY KEY, applicant_name, requested_amount numeric,
      purpose, status NOT NULL, approved_amount numeric, approved_by,
      approved_at timestamptz, rejection_reason, rejected_by,
      disbursement_account, disbursed_at timestamptz,
      created_at timestamptz, updated_at timestamptz,
      last_version integer NOT NULL)               -- + indexes on status, created_at
```

### Consistency and the dual write

The command handler commits the event to Aurora and **then** publishes it to Kinesis. These are two separate writes with no distributed transaction:

- If the Kinesis publish fails after the commit, the event is safely in `events` (the source of truth) and the API returns 500, but the projection will not see that event until it is replayed.
- The projector is idempotent. Updates are guarded by `last_version`, both in the pure mapping (`projectEvent`) and in the SQL `ON CONFLICT ... WHERE loans.last_version < EXCLUDED.last_version`. Duplicate or stale deliveries are no-ops.
- The `loans` read model is disposable. It can be rebuilt at any time by truncating `loans` and replaying `SELECT * FROM events ORDER BY aggregate_id, version` through `projectEvent`.
- Reads are eventually consistent: Kinesis → projector latency plus reader replica lag (typically well under a second) sit between a command and its view.

A transactional outbox (or Aurora → Kinesis CDC) would close the dual-write gap if it matters for your use case.

### Single region: trade-off vs `aws-native`

| | `aws-native` | `aurora` |
|---|---|---|
| Regions | us-east-1 + us-west-2, active-active | us-east-1 only (3 AZs) |
| Event store | DynamoDB Global Table | Aurora PostgreSQL writer |
| Read model | ElastiCache Redis per region | `loans` table on the Aurora reader |
| Projector trigger | DynamoDB Streams | Kinesis |
| API auth | none | IAM (SigV4) |
| Regional outage | other region keeps serving reads and writes | outage until the region recovers (or a manual DR plan) |

An Aurora cluster has exactly one writer, and Aurora Global Database secondaries are read-only. Active-active writes are therefore not possible, so this branch is single-region. High availability within the region comes from the reader instance in a different AZ: Aurora fails over to it automatically. If you need cross-region DR, add an Aurora Global Database secondary (read-only, managed failover). That is not included here.

## Technology Stack

| Component | Service |
|-----------|---------|
| API | API Gateway (REST, IAM auth) + WAF |
| Compute | Lambda (Node.js 20, TypeScript, ARM64, X-Ray) |
| Event Store | Aurora PostgreSQL 16 Serverless v2 — writer instance |
| Read Model | Aurora PostgreSQL — `loans` table via reader instance |
| Event Bus | Kinesis Data Streams (drives the projector) |
| DB driver | `pg` (TLS with certificate verification) + Secrets Manager credentials |
| IaC | AWS CDK (TypeScript) |
| CI/CD | GitHub Actions (`aurora` branch) |

## Security notes

- Aurora runs in `PRIVATE_ISOLATED` subnets (no internet route). Its security group's only ingress is TCP 5432 from the Lambda security group. It is not publicly accessible, and storage is encrypted.
- Credentials are generated by RDS into Secrets Manager. Each function gets `secretsmanager:GetSecretValue` on that secret only.
- Database TLS is verified (`ssl: { rejectUnauthorized: true }`) against the RDS CA that ships with the Lambda Node 20 runtime (`NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem`).
- The API rejects unsigned requests (HTTP 403). Grant callers `execute-api:Invoke` on `arn:aws:execute-api:us-east-1:<account>:<api-id>/prod/*` (or narrower).

## Project Structure

```
├── src/
│   ├── domain/         # Events, Aggregate (shared domain logic — unchanged)
│   ├── shared/
│   │   ├── db.ts             # Secrets Manager + pg.Pool per endpoint (writer/reader)
│   │   └── loan-projection.ts # Pure event → loans row mapping, row → API view
│   ├── commands/       # Command handler Lambda (writer)
│   ├── queries/        # Query handler Lambda (reader)
│   ├── projector/      # Kinesis → loans projection Lambda (writer)
│   ├── health/         # Health check Lambda (SELECT 1 on reader)
│   └── migration/      # Schema DDL + custom-resource migration Lambda
├── infra/
│   ├── app.ts          # CDK app entry point (single stack)
│   └── stacks/aurora-stack.ts  # VPC, Aurora, Kinesis, Lambdas, API GW, WAF
├── test/               # Unit tests (aggregate, projection)
├── demo.sh             # Interactive demo script (SigV4-signed)
└── cdk.json            # CDK configuration
```

## Prerequisites

- Node.js 20+
- AWS CLI v2 (for `aws configure export-credentials`)
- curl 7.75+ (for `--aws-sigv4`), `jq`
- AWS account with CDK bootstrapped in us-east-1 (`npx cdk bootstrap`)

## Build and Test

```bash
npm ci
npx tsc --noEmit
npx jest
npx cdk synth LoanOriginationsAurora
```

## Deploy

The stack is named `LoanOriginationsAurora`, so it does not collide with the `aws-native` stacks (`LoanOriginationsGlobal/Primary/Secondary`) in the same account.

```bash
npm ci
npx cdk deploy LoanOriginationsAurora
```

## Run Demo

`demo.sh` reads the API URL from the `LoanOriginationsAurora` stack outputs (override with `API_URL=...`). It signs every request with your current AWS credentials.

```bash
export AWS_PROFILE=<profile-with-execute-api:Invoke>   # or any other credential source
./demo.sh
```

Manual signed call:

```bash
eval "$(aws configure export-credentials --format env)"
curl -s --aws-sigv4 "aws:amz:us-east-1:execute-api" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  ${AWS_SESSION_TOKEN:+-H "x-amz-security-token: $AWS_SESSION_TOKEN"} \
  "$API_URL/api/loans"
```

## API Endpoints

All endpoints require SigV4 (IAM) authentication.

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/loans | Submit loan application |
| POST | /api/loans/{id}/approve | Approve loan |
| POST | /api/loans/{id}/reject | Reject loan |
| POST | /api/loans/{id}/disburse | Disburse loan |
| GET | /api/loans | List the latest 50 loans (newest first) |
| GET | /api/loans/{id} | Get loan by ID |
| GET | /api/loans/status/{status} | Get loans by status (newest first, capped at 1000) |
| GET | /api/loans/health | Health check (`{"status":"UP","components":{"database":{"status":"UP"}}}`) |

## Cost Notes

Rough us-east-1 on-demand figures. Check current pricing before relying on them.

- **Aurora Serverless v2**: billed per ACU-hour for each instance (writer and reader), plus storage and I/O. At the 0.5 ACU minimum, two instances run about 1 ACU-hour/hour, which is roughly $85–90/month idle. At the 4 ACU maximum the cost is about 8× that. The minimum of 0.5 ACU means the cluster never scales to zero.
- **Provisioned concurrency**: 50 each on the command and query aliases at 512 MB. This is the largest fixed cost here (hundreds of USD/month). Lower or remove `provisionedConcurrentExecutions` for dev/demo use.
- **NAT gateways**: 3 (one per AZ), about $32/month each plus data processing. Lambdas reach Kinesis and Secrets Manager through NAT. VPC interface endpoints are an alternative.
- **Kinesis**: 2 provisioned shards with 7-day retention.
- **Removed vs `aws-native`**: ElastiCache (`cache.r7g.large` × 3 per region × 2 regions) and the DynamoDB Global Table. This is a large saving, offset by the Aurora ACU-hours.
- **Removal policy**: the cluster uses `SNAPSHOT`. `cdk destroy` leaves a final snapshot, which keeps incurring storage cost until you delete it.

## Cleanup

```bash
npx cdk destroy LoanOriginationsAurora
# The final Aurora snapshot remains; list/delete it when no longer needed:
aws rds describe-db-cluster-snapshots --region us-east-1 --snapshot-type manual
```
