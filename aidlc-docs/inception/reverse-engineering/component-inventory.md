# Component Inventory

## Application Packages
- `com.example.loans.axonpoc` — Spring Boot application root
- `com.example.loans.axonpoc.api` — REST API layer (controllers, request DTOs)
- `com.example.loans.axonpoc.command` — Command side (commands, events, aggregate)
- `com.example.loans.axonpoc.query` — Query side (projection, query messages, view model)

## Infrastructure Packages
- `k8s/` — Kubernetes deployment manifests
  - `axon-server.yaml` — Axon Server 3-node StatefulSet
  - `loan-app.yaml` — Application Deployment + Service + Ingress
  - `storage-class.yaml` — EBS gp3 StorageClass

## Shared Packages
- None (self-contained PoC)

## Test Packages
- None defined (test dependencies configured but no test files present)

## Total Count
- **Total Packages**: 4 (application) + 1 (infrastructure)
- **Application**: 4 packages
- **Infrastructure**: 1 (k8s manifests)
- **Shared**: 0
- **Test**: 0
