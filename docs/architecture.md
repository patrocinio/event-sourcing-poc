# AWS-Native Loan Originations — Architecture

CQRS / Event Sourcing on native AWS services, deployed active-active across two
regions. This diagram is derived from the CDK stacks in
[`infra/stacks/global-stack.ts`](../infra/stacks/global-stack.ts) and
[`infra/stacks/regional-stack.ts`](../infra/stacks/regional-stack.ts).

```mermaid
flowchart TB
    client([Client / API Consumer])

    subgraph GLOBAL["Global (deployed in us-east-1)"]
        ddb[("DynamoDB Global Table<br/>LoanEvents — Event Store<br/>PAY_PER_REQUEST · PITR<br/>Streams: NEW_AND_OLD_IMAGES<br/>deletionProtection · RETAIN")]
    end

    subgraph PRIMARY["Region: us-east-1 (Primary) — RegionalStack"]
        direction TB
        waf1["WAF Web ACL<br/>RateLimit + AWS Managed Rules"]
        api1["API Gateway REST<br/>stage: prod · throttle 1000/2000<br/>X-Ray tracing"]

        subgraph VPC1["VPC — 3 AZs · NAT per AZ"]
            cmd1["Lambda: CommandHandler<br/>Node20 · ARM64 · PC=50<br/>replay → validate → append"]
            qry1["Lambda: QueryHandler<br/>in VPC · PC=50"]
            prj1["Lambda: ProjectorHandler<br/>in VPC · DDB Stream source"]
            hlt1["Lambda: HealthHandler<br/>in VPC"]
            redis1[("ElastiCache Redis 7.1<br/>cache.r7g.large · Multi-AZ<br/>1 primary + 2 replicas<br/>TLS + at-rest encryption<br/>Read Model")]
        end

        kin1["Kinesis Data Stream<br/>loan-events-primary<br/>2 shards · 7-day retention"]
    end

    subgraph SECONDARY["Region: us-west-2 (Secondary) — RegionalStack"]
        direction TB
        waf2["WAF Web ACL"]
        api2["API Gateway REST<br/>stage: prod"]

        subgraph VPC2["VPC — 3 AZs · NAT per AZ"]
            cmd2["Lambda: CommandHandler<br/>PC=50"]
            qry2["Lambda: QueryHandler<br/>in VPC · PC=50"]
            prj2["Lambda: ProjectorHandler<br/>stream mapping set post-deploy"]
            hlt2["Lambda: HealthHandler"]
            redis2[("ElastiCache Redis 7.1<br/>Multi-AZ · Read Model")]
        end

        kin2["Kinesis Data Stream<br/>loan-events-secondary<br/>2 shards · 7-day retention"]
    end

    %% Primary request flow
    client --> waf1 --> api1
    api1 -->|POST write cmds| cmd1
    api1 -->|GET reads| qry1
    api1 -->|GET health| hlt1

    cmd1 -->|append events<br/>optimistic concurrency| ddb
    cmd1 -->|publish| kin1
    qry1 -->|read model| redis1
    hlt1 -.-> redis1
    ddb -->|DynamoDB Streams| prj1
    prj1 -->|project / update| redis1

    %% Secondary request flow
    client --> waf2 --> api2
    api2 -->|POST write cmds| cmd2
    api2 -->|GET reads| qry2
    api2 -->|GET health| hlt2

    cmd2 -->|append events| ddb
    cmd2 -->|publish| kin2
    qry2 -->|read model| redis2
    hlt2 -.-> redis2
    ddb -->|DynamoDB Streams| prj2
    prj2 -->|project / update| redis2

    classDef store fill:#2d3a4a,stroke:#7aa2d6,color:#fff
    classDef compute fill:#3a2d4a,stroke:#b07ad6,color:#fff
    classDef edge fill:#4a3a2d,stroke:#d6a27a,color:#fff
    class ddb,redis1,redis2,kin1,kin2 store
    class cmd1,qry1,prj1,hlt1,cmd2,qry2,prj2,hlt2 compute
    class waf1,waf2,api1,api2 edge
```

## Component reference

| Layer | Resource | Notes |
|-------|----------|-------|
| Edge | WAF Web ACL | Rate limiting (2000/IP) + AWS managed rule sets (Common, KnownBadInputs) |
| API | API Gateway REST | `prod` stage, throttle 1000/2000, X-Ray tracing, CORS enabled |
| Compute | Command Lambda | Node 20, ARM64, provisioned concurrency 50; replays events, validates, appends |
| Compute | Query Lambda | In VPC, provisioned concurrency 50; reads only from Redis |
| Compute | Projector Lambda | In VPC; consumes DynamoDB Streams, updates Redis read model |
| Compute | Health Lambda | In VPC; health check against Redis |
| Event Store | DynamoDB Global Table `LoanEvents` | Active-active, PAY_PER_REQUEST, PITR, streams, deletion protection, RETAIN |
| Event Bus | Kinesis Data Stream | Per region, 2 shards, 7-day retention |
| Read Model | ElastiCache Redis 7.1 | `cache.r7g.large`, Multi-AZ, 1 primary + 2 replicas, TLS + at-rest encryption |
| Network | VPC | 3 AZs, NAT gateway per AZ |

## CQRS / Event Sourcing flow

- **Write path**: Client → WAF → API Gateway → Command Lambda → append event to the
  DynamoDB event store (optimistic concurrency) and publish to Kinesis. The command
  handler rebuilds aggregate state by replaying events before validating business rules.
- **Read path**: Client → WAF → API Gateway → Query Lambda → read from ElastiCache
  Redis. The query side never reads from the event store.
- **Projection**: DynamoDB Streams → Projector Lambda → update the Redis read model.

## Multi-region notes

- One `GlobalStack` (the DynamoDB Global Table) is deployed in `us-east-1` and
  replicates to `us-west-2` bi-directionally.
- Two identical `RegionalStack` deployments (`us-east-1` primary, `us-west-2` secondary)
  each provide a full VPC, WAF, API Gateway, four Lambdas, Multi-AZ Redis, and a
  regional Kinesis stream. Both regions serve reads and writes.
- The projector's DynamoDB Stream event source is wired in CDK for the primary region
  only; the secondary region's stream mapping is configured post-deploy via the AWS CLI
  (cross-region stream mapping is not natively supported in CDK).
- Route53 latency-based routing is referenced in `demo.sh` and the CDK `domainName`
  context but is **not** created by the current stacks — DNS is left for manual setup.
