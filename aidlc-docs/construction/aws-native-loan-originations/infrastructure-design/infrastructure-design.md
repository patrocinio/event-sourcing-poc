# Infrastructure Design — AWS-Native Loan Originations

## 1. CDK Stack Architecture

Single CDK app with layered stacks for clean separation:

```
LoanOriginationsApp (CDK App)
├── NetworkStack        — VPC, subnets, security groups
├── DataStack           — DynamoDB, Kinesis, ElastiCache
├── ComputeStack        — Lambda functions, IAM roles
└── ApiStack            — API Gateway, routes, deployment
```

## 2. Network Stack

```
VPC (10.0.0.0/16)
├── Public Subnets (2 AZs)
│   └── NAT Gateway
├── Private Subnets (2 AZs)
│   ├── ElastiCache Redis cluster
│   └── Lambda functions (VPC-attached for Redis access)
└── Internet Gateway
```

| Resource | Details |
|----------|---------|
| VPC | 10.0.0.0/16, DNS enabled |
| Public Subnets | 2 AZs, for NAT + future ALB |
| Private Subnets | 2 AZs, for Lambda + ElastiCache |
| NAT Gateway | Single (PoC cost savings) |
| Security Groups | Lambda SG → Redis SG (port 6379) |

## 3. Data Stack

### DynamoDB — Event Store

| Property | Value |
|----------|-------|
| Table Name | LoanEvents |
| Partition Key | aggregateId (S) |
| Sort Key | version (N) |
| Billing | PAY_PER_REQUEST |
| Streams | NEW_IMAGE |
| Encryption | AWS-managed key |
| Point-in-time Recovery | Enabled |

### Kinesis Data Stream

| Property | Value |
|----------|-------|
| Stream Name | loan-events-stream |
| Shard Count | 1 (PoC) |
| Retention | 24 hours |
| Encryption | AWS-managed key |

### ElastiCache (Redis)

| Property | Value |
|----------|-------|
| Engine | Redis 7.x |
| Node Type | cache.t3.micro (PoC) |
| Nodes | 1 (single node, no replication for PoC) |
| Subnet Group | Private subnets |
| Encryption in-transit | Yes |
| Encryption at-rest | Yes |

## 4. Compute Stack

### Lambda Functions

| Function | Memory | Timeout | VPC | Trigger |
|----------|--------|---------|-----|---------|
| commandHandler | 256 MB | 10s | Yes | API Gateway |
| queryHandler | 256 MB | 5s | Yes | API Gateway |
| projectorHandler | 256 MB | 30s | Yes | DynamoDB Streams |
| kinesisConsumer | 256 MB | 30s | No | Kinesis |
| healthHandler | 128 MB | 5s | Yes | API Gateway |

### IAM Roles (Least Privilege)

| Function | Permissions |
|----------|-------------|
| commandHandler | dynamodb:Query, dynamodb:PutItem on LoanEvents; kinesis:PutRecord on loan-events-stream |
| queryHandler | Redis network access (via VPC SG) |
| projectorHandler | Redis network access (via VPC SG); dynamodb:DescribeStream, dynamodb:GetRecords |
| kinesisConsumer | kinesis:GetRecords, kinesis:GetShardIterator; dynamodb:PutItem on LoanEvents |
| healthHandler | Redis network access (via VPC SG) |

### Runtime Configuration

| Property | Value |
|----------|-------|
| Runtime | Node.js 20.x |
| Architecture | arm64 (Graviton — cheaper) |
| Bundling | esbuild (via CDK NodejsFunction) |
| Layers | None (bundled) |

## 5. API Stack

### API Gateway (REST API)

| Property | Value |
|----------|-------|
| Type | REST API |
| Stage | prod |
| Throttling | 100 req/s (PoC) |
| Logging | Full request/response |
| X-Ray | Enabled |

### Routes

| Method | Resource | Integration | Auth |
|--------|----------|-------------|------|
| POST | /api/loans | commandHandler | None (PoC) |
| POST | /api/loans/{id}/approve | commandHandler | None (PoC) |
| POST | /api/loans/{id}/reject | commandHandler | None (PoC) |
| POST | /api/loans/{id}/disburse | commandHandler | None (PoC) |
| GET | /api/loans | queryHandler | None (PoC) |
| GET | /api/loans/{id} | queryHandler | None (PoC) |
| GET | /api/loans/status/{status} | queryHandler | None (PoC) |
| GET | /api/loans/health | healthHandler | None (PoC) |

## 6. Event Flow Diagram

```
                    ┌──────────────────────────────────────────────┐
                    │              WRITE PATH                       │
                    │                                              │
  Client ──POST──▶ API GW ──▶ commandHandler Lambda               │
                    │              │                                │
                    │              ├─ Query DynamoDB (replay events)│
                    │              ├─ Validate state transition     │
                    │              ├─ PutItem DynamoDB (new event)  │
                    │              └─ PutRecord Kinesis             │
                    └──────────────────────────────────────────────┘

                    ┌──────────────────────────────────────────────┐
                    │              READ PATH                        │
                    │                                              │
  Client ──GET───▶ API GW ──▶ queryHandler Lambda                 │
                    │              │                                │
                    │              └─ GET from Redis                │
                    └──────────────────────────────────────────────┘

                    ┌──────────────────────────────────────────────┐
                    │           PROJECTION PATH                    │
                    │                                              │
  DynamoDB Streams ──▶ projectorHandler Lambda                    │
                    │              │                                │
                    │              └─ SET/ZADD/SADD in Redis        │
                    └──────────────────────────────────────────────┘
```

## 7. Cost Estimate (PoC — Low Traffic)

| Service | Monthly Estimate |
|---------|-----------------|
| Lambda | ~$0 (free tier) |
| DynamoDB | ~$0 (free tier, on-demand) |
| Kinesis | ~$15 (1 shard) |
| ElastiCache | ~$13 (cache.t3.micro) |
| API Gateway | ~$0 (free tier) |
| NAT Gateway | ~$33 |
| **Total** | **~$61/month** |

---

**Infrastructure Design Complete.**

A) Continue to Code Generation

B) Request Changes

[Answer]: 
