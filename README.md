# Aurora Loan Originations — CQRS/Event Sourcing (`aurora` branch)

A serverless implementation of CQRS (Command Query Responsibility Segregation) and Event Sourcing on AWS, with an **Aurora PostgreSQL Serverless v2 Global Database** as both the event store and the read model, deployed to **two regions** (us-east-1 primary, us-west-2 secondary). This branch is derived from `aws-native` (DynamoDB Global Tables + ElastiCache Redis) and is the AWS counterpart of the [Axon Framework PoC](https://github.com/patrocinio/axon-poc/tree/main) on `main`.

The domain logic (`src/domain`) and the REST API contract (paths, request bodies, response JSON and status codes) are unchanged from `aws-native`. The API requires IAM (SigV4) authentication in both regions.

## Architecture

```
            us-east-1 (PRIMARY)                          us-west-2 (SECONDARY)
   Client (SigV4) ─▶ API Gateway + WAF          Client (SigV4) ─▶ API Gateway + WAF
          │ POST            │ GET                      │ POST            │ GET
          ▼                 ▼                          ▼                 ▼
     Command λ          Query λ                   Command λ          Query λ
          │ INSERT          ▲ SELECT loans             │ INSERT          ▲ SELECT loans
          ▼                 │                          ▼                 │
  ┌────────────────┐  ┌───────────┐          ┌────────────────┐  ┌──────────────┐
  │ Aurora WRITER  │  │ Aurora    │          │ secondary      │  │ 2 serverless │
  │ events + loans │  │ READER    │          │ cluster endpt  │  │ v2 replicas  │
  └──▲─────┬───────┘  └───────────┘          └───────┬────────┘  └──────▲───────┘
     │     │      ◀──── global write forwarding ─────┘                  │
     │     └─────────── storage-level replication (typically < 1 s) ────┘
     │
     │ upsert loans          publish (after commit) from BOTH regions
  ┌──┴─────────┐   ┌─────────────────────────────────┐
  │ Projector λ│◀──│ Kinesis loan-events-aurora      │◀── Command λ (us-east-1, us-west-2)
  └────────────┘   └─────────────────────────────────┘
```

Two CDK stacks (`infra/app.ts`), linked only by fixed physical names (no cross-region CloudFormation references):

| Stack | Region | Contents |
|---|---|---|
| `LoanOriginationsAuroraPrimary` | us-east-1 | VPC, Aurora cluster (writer + reader), Global Database `loan-aurora-global`, credentials secret `loan-aurora/db-credentials` (replicated to us-west-2), Kinesis `loan-events-aurora`, schema migration, projector, command/query/health Lambdas, API Gateway + WAF |
| `LoanOriginationsAuroraSecondary` | us-west-2 | VPC, KMS key, secondary cluster joined to `loan-aurora-global` with write forwarding, 2 `db.serverless` replica instances, command/query/health Lambdas, API Gateway + WAF |

`secondary.addDependency(primary)`: CDK deploys the primary first and destroys the secondary first.

- **Primary writer (us-east-1)**: the only writer of the global database. The `events` table is the event store. Appends are plain `INSERT`s; the primary key `(aggregate_id, version)` provides optimistic concurrency, so a concurrent writer gets a unique violation (SQLSTATE 23505) and the API returns `409 {"error":"Concurrent modification, retry"}`. The projector writes the `loans` projection here too.
- **Secondary cluster (us-west-2)**: read-only. It is created with `EnableGlobalWriteForwarding: true`, so the us-west-2 command Lambda sends its `INSERT`s to the secondary cluster endpoint and Aurora forwards them to the us-east-1 writer. Each new writer connection runs `SET apg_write_forward.consistency_mode = 'SESSION'` (`src/shared/db.ts`, via the pool's awaited `onConnect` hook), so a session reads its own forwarded writes.
- **Region-local reads**: each region's query and health Lambdas use their region's reader endpoint (us-east-1 reader instance, us-west-2 replica instances). Global Database replication lag is typically under a second.
- **Stale reads are safe**: a us-west-2 command may replay a slightly stale event history (another region's latest event not yet replicated). It then computes a version that already exists, the forwarded `INSERT` hits the PK, and the client gets a 409 and retries. No event is ever lost or overwritten.
- **Kinesis + projector in the primary only**: both regions' command Lambdas publish to the single us-east-1 stream (the us-west-2 Lambda uses `KINESIS_REGION=us-east-1` and has `kinesis:PutRecord(s)` on that exact stream ARN). There is one writer, so there is one projector that writes to it. Because publishes come from two regions, Kinesis can deliver a loan's events out of order. The projector is therefore **order-insensitive**: a record is only a notification that loan X changed. For each notified loan, inside one writer transaction, it locks the `loans` row (`SELECT ... FOR UPDATE`), loads **all** of the loan's events from `events` on the writer, folds them with `projectAll` (sort by version, dedupe), and upserts with `WHERE loans.last_version < EXCLUDED.last_version`. Duplicates, replays and reordering converge to the same row. The row reaches us-west-2 through Global Database replication.
- **Credentials**: RDS generates the master credentials into `loan-aurora/db-credentials` in us-east-1. Secrets Manager replicates it to us-west-2 (same name and suffix). The secondary stack imports it with `Secret.fromSecretNameV2`; its IAM grants target `...:secret:loan-aurora/db-credentials-??????` in us-west-2, which matches the replica's full ARN.
- **Encryption**: each region has its own customer-managed KMS key (rotation on). A cross-region encrypted secondary must use a key in its own region.
- **IAM-authenticated API** (both regions): every method uses `AWS_IAM` authorization. Callers sign requests with SigV4 for the API's region and need `execute-api:Invoke`. CORS preflight (`OPTIONS`) mocks stay unauthenticated because browsers never sign preflights, and they return no data.
- **Schema migration** (primary only): a CDK custom resource runs idempotent DDL (`CREATE ... IF NOT EXISTS`) on the writer before any API Lambda is created. It re-runs whenever the DDL changes (hash of `src/migration/schema.ts`). The schema reaches us-west-2 through replication.

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

- If the Kinesis publish fails after the commit, the event is safely in `events` (the source of truth) and the API returns 500. The projection catches up on the **next** notification for that loan, because the projector rebuilds from the full event history rather than applying the single record.
- The projector is idempotent and order-insensitive (see above). `projectEvent`'s `last_version` guard and the SQL `ON CONFLICT ... WHERE loans.last_version < EXCLUDED.last_version` make stale writes no-ops.
- The `loans` read model is disposable. It can be rebuilt at any time by truncating `loans` and running `projectAll` over each aggregate's events.
- Reads are eventually consistent: Kinesis → projector latency, plus in-region reader lag, plus (for us-west-2) Global Database replication lag sit between a command and its view.

A transactional outbox (or Aurora → Kinesis CDC) would close the dual-write gap if it matters for your use case.

### Multi-region trade-offs vs `aws-native`

| | `aws-native` | `aurora` |
|---|---|---|
| Regions | us-east-1 + us-west-2, active-active | us-east-1 + us-west-2, single writer + write forwarding |
| Event store | DynamoDB Global Table | Aurora Global Database (writer in us-east-1) |
| Read model | ElastiCache Redis per region | `loans` table on each region's Aurora replicas |
| Projector trigger | DynamoDB Streams (per region) | Kinesis (us-east-1 only) |
| API auth | none | IAM (SigV4) |
| us-west-2 write latency | local | cross-region round trip (forwarded to us-east-1) |
| us-east-1 outage | other region keeps serving reads and writes | us-west-2 reads keep working; writes need a global failover (below) |

If you need true active-active writes in both regions (each region committing locally, strong consistency across regions), use **Amazon Aurora DSQL** instead of Aurora Global Database.

## Failover / switchover runbook

Both operations promote the us-west-2 cluster to be the global writer.

- **Planned switchover** (both regions healthy, no data loss):
  ```bash
  aws rds switchover-global-cluster --region us-east-1 \
    --global-cluster-identifier loan-aurora-global \
    --target-db-cluster-identifier <us-west-2 cluster ARN>
  ```
- **Unplanned failover** (us-east-1 impaired; may lose the last un-replicated writes):
  ```bash
  aws rds failover-global-cluster --region us-west-2 \
    --global-cluster-identifier loan-aurora-global \
    --target-db-cluster-identifier <us-west-2 cluster ARN> --allow-data-loss
  ```

The database endpoints keep their names, but their roles swap. The application layer is wired for us-east-1 as primary, so after promotion do these manual steps:

1. **us-west-2 writes**: the us-west-2 command Lambda already writes to its cluster endpoint, which is now the writer. Remove `DB_WRITE_FORWARDING` from the us-west-2 functions: the session `SET` only matters on a secondary, and whether a writer accepts it was not verified.
2. **Event stream + projector**: Kinesis and the projector exist only in us-east-1. If us-east-1 is unavailable, create a stream in us-west-2, set `KINESIS_STREAM_NAME`/`KINESIS_REGION` on the us-west-2 command Lambda to it, and deploy a projector in us-west-2 (same code, `DB_WRITER_HOST` = the us-west-2 cluster endpoint) consuming that stream. Then re-notify every loan whose events are ahead of its projection (`SELECT DISTINCT e.aggregate_id FROM events e LEFT JOIN loans l ON l.loan_id = e.aggregate_id WHERE l.loan_id IS NULL OR e.version > l.last_version`). Because the projector rebuilds from `events`, records lost with the us-east-1 stream are recovered this way.
3. **Migration**: the migration custom resource targets the us-east-1 endpoint, which is now read-only. Don't change the schema while failed over, or apply the DDL manually against the us-west-2 writer.
4. **us-east-1 Lambdas** (once the region is back as a secondary): their writer endpoint is now read-only. Either enable write forwarding on the us-east-1 cluster (`aws rds modify-db-cluster --enable-global-write-forwarding`) and set `DB_WRITE_FORWARDING=true` on its Lambdas, or keep us-east-1 read-only until you switch back.
5. **Switch back** to us-east-1 with `switchover-global-cluster` before the next `cdk deploy`, so the stacks again describe the real topology.

## Technology Stack

| Component | Service |
|-----------|---------|
| API | API Gateway (REST, IAM auth) + WAF, per region |
| Compute | Lambda (Node.js 20, TypeScript, ARM64, X-Ray) |
| Event Store | Aurora PostgreSQL 16.13 Serverless v2 Global Database — us-east-1 writer |
| Read Model | Aurora PostgreSQL — `loans` table via each region's replicas |
| Event Bus | Kinesis Data Streams in us-east-1 (drives the projector) |
| DB driver | `pg` (TLS with certificate verification) + Secrets Manager credentials |
| IaC | AWS CDK (TypeScript), 2 stacks |
| CI/CD | GitHub Actions (`aurora` branch, `cdk deploy --all`) |

## Security notes

- Aurora runs in `PRIVATE_ISOLATED` subnets (no internet route) in both regions. Each region's DB security group's only ingress is TCP 5432 from that region's Lambda security group. Instances are not publicly accessible, and storage is encrypted with a customer-managed KMS key per region.
- Credentials are generated by RDS into Secrets Manager and replicated to us-west-2. Each function gets `secretsmanager:GetSecretValue` on its region's copy only.
- Database TLS is verified (`ssl: { rejectUnauthorized: true }`) against the RDS CA that ships with the Lambda Node 20 runtime (`NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem`).
- Both APIs reject unsigned requests (HTTP 403). Grant callers `execute-api:Invoke` on `arn:aws:execute-api:<region>:<account>:<api-id>/prod/*` (or narrower) for each region's API.
- The us-west-2 command Lambda can only `kinesis:PutRecord`/`PutRecords` on `arn:aws:kinesis:us-east-1:<account>:stream/loan-events-aurora`.

## Project Structure

```
├── src/
│   ├── domain/         # Events, Aggregate (shared domain logic — unchanged)
│   ├── shared/
│   │   ├── db.ts             # Secrets Manager + pg.Pool per endpoint (writer/reader), write-forwarding session mode
│   │   └── loan-projection.ts # Pure event → loans row mapping (projectEvent, projectAll), row → API view
│   ├── commands/       # Command handler Lambda (writer / write-forwarding endpoint)
│   ├── queries/        # Query handler Lambda (region-local reader)
│   ├── projector/      # Kinesis-notified, order-insensitive loans projection (primary only)
│   ├── health/         # Health check Lambda (SELECT 1 on region-local reader)
│   └── migration/      # Schema DDL + custom-resource migration Lambda (primary only)
├── infra/
│   ├── app.ts          # CDK app: primary (us-east-1) + secondary (us-west-2) stacks
│   ├── config.ts       # Shared fixed names, engine version, ACU range
│   ├── constructs/
│   │   ├── loan-network.ts  # VPC (3 AZs, 3 tiers), Lambda SG, DB SG
│   │   └── loan-service.ts  # Lambda factory, command/query/health, API Gateway (IAM) + WAF
│   └── stacks/
│       ├── aurora-primary-stack.ts    # Aurora cluster, Global Database, secret, Kinesis, projector, migration
│       └── aurora-secondary-stack.ts  # Secondary cluster (write forwarding), replicas, cross-region Kinesis grant
├── test/               # Unit tests (aggregate, projection incl. projectAll, db pool config)
├── demo.sh             # Interactive two-region demo script (SigV4-signed)
└── cdk.json            # CDK configuration
```

## Prerequisites

- Node.js 20+
- AWS CLI v2 (for `aws configure export-credentials`)
- curl 7.75+ (for `--aws-sigv4`), `jq`
- AWS account with CDK bootstrapped in **both** regions (`npx cdk bootstrap aws://<account>/us-east-1 aws://<account>/us-west-2`)

## Build and Test

```bash
npm ci
npx tsc --noEmit
npx jest
npx cdk synth --all
```

## Deploy

```bash
npm ci
npx cdk deploy --all        # primary first, then secondary (stack dependency)
```

The stack names do not collide with the `aws-native` stacks (`LoanOriginationsGlobal/Primary/Secondary`). If the earlier single-region `LoanOriginationsAurora` stack is still deployed, destroy it first: it owns a Kinesis stream with the same name (`loan-events-aurora`).

## Run Demo

`demo.sh` reads both API URLs from the stacks' `ApiUrl` outputs (override with `API_URL_EAST=...` / `API_URL_WEST=...`). It signs every request with your current AWS credentials for the target region. Part 7 submits a loan in us-east-1, approves it in us-west-2 (forwarded write), disburses it in us-east-1, and reads it back from both regions' replicas.

```bash
export AWS_PROFILE=<profile-with-execute-api:Invoke>   # or any other credential source
./demo.sh
```

Manual signed call (replace the region in both places):

```bash
eval "$(aws configure export-credentials --format env)"
curl -s --aws-sigv4 "aws:amz:us-west-2:execute-api" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  ${AWS_SESSION_TOKEN:+-H "x-amz-security-token: $AWS_SESSION_TOKEN"} \
  "$API_URL_WEST/api/loans"
```

## API Endpoints

Identical in both regions. All endpoints require SigV4 (IAM) authentication.

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

Rough on-demand figures. Check current pricing before relying on them.

- **Aurora Serverless v2**: 4 instances (us-east-1 writer + reader, 2 us-west-2 replicas), each billed per ACU-hour with a 0.5 ACU floor. Idle that is about 2 ACU-hours/hour, roughly $170–180/month, plus storage in both regions. At the 4 ACU maximum the cost is about 8× that. Serverless v2 never scales to zero at a 0.5 ACU minimum.
- **Global Database**: replicated write I/Os to us-west-2 and cross-region data transfer are billed on top. Forwarded writes from us-west-2 also cross regions.
- **Provisioned concurrency**: 50 each on the command and query aliases at 512 MB, in **both** regions (4 aliases). This is the largest fixed cost here (several hundred USD/month). Lower or remove `provisionedConcurrentExecutions` for dev/demo use.
- **NAT gateways**: 3 per region (6 total), about $32/month each plus data processing. Lambdas reach Kinesis and Secrets Manager through NAT (the us-west-2 command Lambda reaches the us-east-1 stream that way). VPC interface endpoints are an alternative for same-region services.
- **Kinesis**: 2 provisioned shards with 7-day retention (us-east-1 only).
- **KMS**: one customer-managed key per region (~$1/month each). The us-east-1 key is retained after destroy so the final snapshot stays restorable.
- **Removal policy**: the primary cluster uses `SNAPSHOT`, so `cdk destroy` leaves a final snapshot, which keeps incurring storage cost until you delete it. The secondary cluster and its instances use `Delete`: they are replicas of the primary's storage, and a retained secondary would block deleting the global cluster.

## Cleanup

Destroy order matters: the secondary must leave the global cluster before the primary and the global cluster can be deleted. `cdk destroy --all` follows the stack dependency and removes `LoanOriginationsAuroraSecondary` first.

```bash
npx cdk destroy --all        # secondary (us-west-2) first, then primary (us-east-1)
```

If CloudFormation cannot remove a cluster from the global cluster, detach it manually and retry the destroy:

```bash
# Secondary (run before destroying the secondary stack, if needed)
aws rds remove-from-global-cluster --region us-west-2 \
  --global-cluster-identifier loan-aurora-global --db-cluster-identifier <us-west-2 cluster ARN>
# Primary / global cluster
aws rds remove-from-global-cluster --region us-east-1 \
  --global-cluster-identifier loan-aurora-global --db-cluster-identifier <us-east-1 cluster ARN>
aws rds delete-global-cluster --region us-east-1 --global-cluster-identifier loan-aurora-global
```

Leftovers to review:

```bash
# Final snapshot of the primary cluster
aws rds describe-db-cluster-snapshots --region us-east-1 --snapshot-type manual
# The fixed-name secret: if a redeploy fails because it is scheduled for deletion,
# restore it or force-delete it (replica first):
aws secretsmanager describe-secret --region us-east-1 --secret-id loan-aurora/db-credentials
```

The retained us-east-1 KMS key can be scheduled for deletion once the final snapshot is no longer needed.
