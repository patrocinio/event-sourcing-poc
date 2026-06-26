# Production Infrastructure Design — Multi-Region Active-Active

## Overview

Production-ready CQRS/Event Sourcing system running active-active across
us-east-1 and us-west-2 with multi-AZ resilience in each region.

## Key Changes from PoC

| Concern | PoC | Production |
|---------|-----|-----------|
| Regions | 1 (us-east-1) | 2 (us-east-1 + us-west-2) active-active |
| AZs per region | 2 | 3 |
| DynamoDB | Single-region | Global Tables (automatic multi-region replication) |
| ElastiCache | Single node | Multi-AZ replication group (automatic failover) |
| NAT Gateway | 1 per region | 1 per AZ (3 per region) |
| API Gateway | Regional | Regional per region, fronted by Route53 latency routing |
| DNS | None | Route53 with health checks and latency-based routing |
| Auth | None | Cognito User Pool (replicated) |
| WAF | None | AWS WAF on both API Gateways |
| Kinesis | 1 shard | 2 shards per region |
| Lambda concurrency | Default | Provisioned concurrency (50 per function) |
| Monitoring | Basic CloudWatch | CloudWatch + Contributor Insights + dashboards |

## Architecture

```
                         Route53 (Latency-Based Routing)
                                    │
                    ┌───────────────┼───────────────┐
                    ▼                               ▼
           ┌───────────────┐               ┌───────────────┐
           │  us-east-1    │               │  us-west-2    │
           │               │               │               │
           │  API Gateway  │               │  API Gateway  │
           │  + WAF        │               │  + WAF        │
           │       │       │               │       │       │
           │  ┌────┴────┐  │               │  ┌────┴────┐  │
           │  │ Lambda   │  │               │  │ Lambda   │  │
           │  │ (Command)│  │               │  │ (Command)│  │
           │  └────┬─────┘  │               │  └────┬─────┘  │
           │       │        │               │       │        │
           │  ┌────┴─────────────────────────────────┴────┐  │
           │  │        DynamoDB Global Tables              │  │
           │  │     (automatic bi-directional replication) │  │
           │  └────┬─────────────────────────────────┬────┘  │
           │       │        │               │       │        │
           │  DDB Streams   │               │  DDB Streams   │
           │       │        │               │       │        │
           │  ┌────┴────┐   │               │  ┌────┴────┐   │
           │  │Projector │   │               │  │Projector │   │
           │  │ Lambda   │   │               │  │ Lambda   │   │
           │  └────┬─────┘   │               │  └────┬─────┘   │
           │       │         │               │       │         │
           │  ┌────┴────┐   │               │  ┌────┴────┐   │
           │  │ElastiCache│  │               │  │ElastiCache│  │
           │  │(Multi-AZ) │  │               │  │(Multi-AZ) │  │
           │  └───────────┘  │               │  └───────────┘  │
           └─────────────────┘               └─────────────────┘
```

## Conflict Resolution (Active-Active Event Sourcing)

DynamoDB Global Tables use "last writer wins" for conflicts. For event sourcing,
we use a composite sort key: `{version}#{region}#{timestamp}` to ensure:
1. No two events collide on the same version from different regions
2. Aggregate replay is deterministic regardless of which region reads

## CDK Stack Structure (per region)

```
LoanOriginationsApp
├── GlobalStack (us-east-1 only)
│   ├── Route53 HealthChecks + Latency Records
│   └── DynamoDB Global Table definition
├── RegionalStack (deployed to each region)
│   ├── VPC (3 AZs, 3 NAT Gateways)
│   ├── ElastiCache (Multi-AZ replication group)
│   ├── Lambda functions (provisioned concurrency)
│   ├── API Gateway + WAF
│   └── Kinesis (2 shards)
```
