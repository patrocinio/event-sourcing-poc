# AWS-Native Loan Originations — CQRS/Event Sourcing

A serverless implementation of CQRS (Command Query Responsibility Segregation) and Event Sourcing patterns using native AWS services. This is the AWS-native equivalent of the [Axon Framework PoC](https://github.com/patrocinio/axon-poc/tree/main) on the `main` branch.

## Architecture

```
┌──────────────┐     ┌────────────┐     ┌──────────────┐
│  API Gateway │────▶│  Command   │────▶│  DynamoDB    │
│  (REST API)  │     │  Lambda    │     │ (Event Store)│
└──────────────┘     └────────────┘     └──────┬───────┘
      │                                        │
      │                              DynamoDB Streams
      │                                        ▼
      │             ┌────────────┐    ┌────────────────┐
      └────────────▶│   Query    │    │   Projector    │
                    │   Lambda   │    │    Lambda      │
                    └─────┬──────┘    └───────┬────────┘
                          ▼                    ▼
                    ┌──────────────────────────────┐
                    │   ElastiCache (Redis)        │
                    └──────────────────────────────┘
```

## Technology Stack

| Component | Service |
|-----------|---------|
| API | API Gateway (REST) |
| Compute | Lambda (Node.js 20, TypeScript, ARM64) |
| Event Store | DynamoDB (single-table, streams enabled) |
| Event Bus | Kinesis Data Streams |
| Read Model | ElastiCache (Redis 7.x) |
| IaC | AWS CDK (TypeScript) |
| CI/CD | GitHub Actions |

## Project Structure

```
├── src/
│   ├── domain/         # Events, Aggregate (shared domain logic)
│   ├── commands/       # Command handler Lambda
│   ├── queries/        # Query handler Lambda
│   ├── projector/      # DynamoDB Streams → Redis projector Lambda
│   └── health/         # Health check Lambda
├── infra/
│   ├── app.ts          # CDK app entry point
│   └── stacks/         # CDK stacks (Network, Data, Compute, API)
├── test/               # Unit tests
├── demo.sh             # Interactive demo script
└── cdk.json            # CDK configuration
```

## Prerequisites

- Node.js 20+
- AWS CLI configured
- AWS CDK CLI (`npm install -g aws-cdk`)
- AWS account with CDK bootstrapped (`cdk bootstrap`)

## Deploy

```bash
npm install
cdk deploy --all
```

## Run Demo

```bash
export API_URL=$(aws cloudformation describe-stacks --stack-name LoanOriginationsApi \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
./demo.sh
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/loans | Submit loan application |
| POST | /api/loans/{id}/approve | Approve loan |
| POST | /api/loans/{id}/reject | Reject loan |
| POST | /api/loans/{id}/disburse | Disburse loan |
| GET | /api/loans | List all loans |
| GET | /api/loans/{id} | Get loan by ID |
| GET | /api/loans/status/{status} | Get loans by status |
| GET | /api/loans/health | Health check |

## Cleanup

```bash
cdk destroy --all
```
