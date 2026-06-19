# AXON Event Sourcing PoC — Loan Originations

A minimal Axon Framework + Axon Server proof-of-concept demonstrating the full **CQRS flow** for a Loan Originations platform, packaged for EKS deployment.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     EKS Cluster                              │
│                                                             │
│  ┌──────────────────────┐     ┌──────────────────────────┐ │
│  │  loan-originations   │     │    Axon Server Cluster    │ │
│  │  (Spring Boot + Axon │────▶│    (3-node StatefulSet)   │ │
│  │   Framework)         │     │                          │ │
│  │                      │     │  ┌────┐ ┌────┐ ┌────┐   │ │
│  │  Command Side:       │     │  │ N0 │ │ N1 │ │ N2 │   │ │
│  │   - LoanAggregate    │     │  └────┘ └────┘ └────┘   │ │
│  │   - Command Handlers │     │   (AZ-a)  (AZ-b) (AZ-c) │ │
│  │                      │     │                          │ │
│  │  Query Side:         │     │  Event Store (EBS gp3)   │ │
│  │   - LoanProjection   │     │  Raft Consensus          │ │
│  │   - Query Handlers   │     │  gRPC :8124 / :8224      │ │
│  └──────────────────────┘     └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## CQRS Flow Demonstrated

```
POST /api/loans (Submit Application)
  └─▶ SubmitLoanApplicationCommand
       └─▶ LoanAggregate (validates, emits event)
            └─▶ LoanApplicationSubmittedEvent → Axon Server (stored)
                 └─▶ LoanProjection (updates read model)
                      └─▶ GET /api/loans/{id} (returns current state)
```

## Quick Start (Local)

```bash
# 1. Start Axon Server (single node for local dev)
docker run -d --name axon-server -p 8024:8024 -p 8124:8124 axoniq/axonserver:2024.1.2

# 2. Build and run the application
./gradlew bootRun

# 3. Test the CQRS flow
# Submit a loan application
curl -X POST http://localhost:8080/api/loans \
  -H "Content-Type: application/json" \
  -d '{"applicantName":"Jane Doe","requestedAmount":250000,"purpose":"Home Purchase"}'

# Query loans (read side)
curl http://localhost:8080/api/loans

# Approve the loan
curl -X POST http://localhost:8080/api/loans/{loanId}/approve \
  -H "Content-Type: application/json" \
  -d '{"approvedAmount":240000,"approvedBy":"underwriter-001"}'

# Disburse
curl -X POST http://localhost:8080/api/loans/{loanId}/disburse \
  -H "Content-Type: application/json" \
  -d '{"disbursementAccount":"ACCT-9876543210"}'
```

## EKS Deployment

### Prerequisites
- EKS cluster with EBS CSI driver
- `kubectl` configured for your cluster
- ECR repository for the application image

### Deploy

```bash
# 1. Create namespace + storage class
kubectl apply -f k8s/storage-class.yaml
kubectl apply -f k8s/axon-server.yaml

# 2. Wait for Axon Server cluster to form (3 nodes + leader election)
kubectl -n axon-poc get pods -w
# Wait until all 3 axon-server pods are Running + Ready

# 3. Build and push application image
docker build -t <ECR_REPO>/axon-poc-loan-originations:latest .
docker push <ECR_REPO>/axon-poc-loan-originations:latest

# 4. Deploy application (update image in loan-app.yaml first)
kubectl apply -f k8s/loan-app.yaml

# 5. Verify
kubectl -n axon-poc get pods
kubectl -n axon-poc logs -l app=loan-originations-poc --tail=50
```

### Verify Cluster Health

```bash
# Axon Server dashboard (port-forward for PoC)
kubectl -n axon-poc port-forward svc/axon-server-client 8024:8024
# Open http://localhost:8024 — shows cluster nodes, event counts, connected apps

# Test API via port-forward
kubectl -n axon-poc port-forward svc/loan-originations-poc 8080:80
curl http://localhost:8080/api/loans
```

## Network Validation Tests

Use this PoC to validate Axon Server networking within your network topology:

| Test | What to Measure | Pass Criteria |
|------|----------------|---------------|
| Cross-AZ replication | Time for event to replicate to all nodes | < 5ms |
| Leader election | Time to elect new leader after node kill | < 10s |
| Client reconnect | App reconnects after Axon Server failover | < 30s |
| Throughput | Events/sec under steady load | > 10,000 e/s |
| TGW latency | Additional latency from TGW routing | < 2ms overhead |

```bash
# Kill a node and measure recovery
kubectl -n axon-poc delete pod axon-server-1
# Monitor: time until new leader elected + client reconnects
kubectl -n axon-poc logs -l app=loan-originations-poc -f | grep -i "connect"
```

## Project Structure

```
axon-poc/
├── build.gradle.kts              # Dependencies (Axon Framework 4.9.4 + Spring Boot 3.3)
├── settings.gradle.kts
├── Dockerfile                     # Multi-stage build (Corretto 17)
├── src/main/kotlin/.../
│   ├── AxonPocApplication.kt     # Spring Boot entry point
│   ├── command/
│   │   ├── Commands.kt            # Command messages (write-side intent)
│   │   ├── Events.kt              # Domain events (immutable facts)
│   │   └── LoanAggregate.kt       # Aggregate root (command handlers + ES handlers)
│   ├── query/
│   │   └── LoanProjection.kt      # Read model (event handlers + query handlers)
│   └── api/
│       └── LoanController.kt      # REST API (commands + queries)
├── src/main/resources/
│   └── application.yml            # Axon Server connection + event processing config
└── k8s/
    ├── axon-server.yaml           # 3-node StatefulSet + headless service
    ├── loan-app.yaml              # Application Deployment + Ingress
    └── storage-class.yaml         # EBS gp3 for event store volumes
```

## Key Axon Concepts Demonstrated

| Concept | File | What It Shows |
|---------|------|---------------|
| Event Sourcing | `LoanAggregate.kt` | State rebuilt from events, not DB reads |
| CQRS Separation | `command/` vs `query/` | Write model ≠ Read model |
| Command Validation | `LoanAggregate.kt` | Business rules enforced before events emitted |
| Projection | `LoanProjection.kt` | Read model updated asynchronously from events |
| Tracking Processor | `application.yml` | Position tracking for replay capability |
| Axon Server routing | (auto via framework) | Commands routed to correct aggregate instance |

## Production Considerations (Beyond PoC)

- [ ] Replace H2 with RDS PostgreSQL for token/saga store
- [ ] Add Axon Server Enterprise Edition license for multi-node HA
- [ ] Implement snapshotting for aggregates with many events
- [ ] Add event upcasters for schema evolution
- [ ] Configure TLS between app ↔ Axon Server (mTLS in prod)
- [ ] Add Prometheus metrics export for CloudWatch
- [ ] Implement dead letter queue for failed event handlers
- [ ] Add integration tests with Axon Test fixtures
