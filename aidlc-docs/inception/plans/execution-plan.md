# Execution Plan — AWS-Native Loan Originations

## Project Summary
Replace Axon Framework PoC with a fully serverless AWS-native CQRS/Event Sourcing implementation using TypeScript, Lambda, DynamoDB, Kinesis, ElastiCache, and CDK.

## Execution Phases

### INCEPTION PHASE (COMPLETED)
- [x] Workspace Detection
- [x] Requirements Analysis (reverse engineering artifacts leveraged from main branch)
- [x] Workflow Planning (this document)
- [ ] Skipped: User Stories (requirements are clear from existing PoC)
- [ ] Skipped: Units Generation (single unit of work)

### CONSTRUCTION PHASE

#### Unit 1: AWS-Native Loan Originations (Single Unit)

| Stage | Execute? | Rationale |
|-------|----------|-----------|
| Functional Design | YES | Need to define DynamoDB table schemas, event formats, aggregate logic |
| NFR Requirements | SKIP | Already captured in requirements.md |
| NFR Design | SKIP | Straightforward serverless patterns |
| Infrastructure Design | YES | CDK stack design, VPC layout for ElastiCache |
| Code Generation | YES | Full implementation |
| Build and Test | YES | CDK synth, unit tests, integration tests |

#### Execution Sequence:
```
Functional Design → Infrastructure Design → Code Generation → Build and Test
```

## Deliverables

### Code Artifacts
1. `src/` — TypeScript Lambda functions
   - `src/commands/` — Command handlers (submit, approve, reject, disburse)
   - `src/queries/` — Query handlers (get all, get by ID, get by status)
   - `src/projector/` — DynamoDB Streams projector (updates Redis)
   - `src/events/` — Event type definitions
   - `src/aggregate/` — Loan aggregate (event replay logic)
2. `infra/` — AWS CDK TypeScript stack
3. `test/` — Unit and integration tests
4. `.github/workflows/deploy.yml` — CI/CD pipeline
5. `demo.sh` — Interactive demo script

### Documentation
1. `README.md` — Updated for AWS-native architecture
2. Architecture diagram
3. Build and test instructions

## Estimated Stages: 4
1. Functional Design (~15 min)
2. Infrastructure Design (~10 min)
3. Code Generation (~30 min)
4. Build and Test (~10 min)

## Decision: No Application Design or Units Generation needed
- Single cohesive unit of work
- Clear component boundaries from requirements
- Standard serverless patterns (no novel architecture decisions)

---

**Ready to proceed to Functional Design?**

A) Approve and proceed

B) Request changes to the execution plan

[Answer]: 
