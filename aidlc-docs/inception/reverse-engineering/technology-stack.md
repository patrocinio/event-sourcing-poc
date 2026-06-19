# Technology Stack

## Programming Languages
- Kotlin 1.9.24 — Application code (all source files)

## Frameworks
- Spring Boot 3.3.0 — Web framework, dependency injection, actuator
- Axon Framework 4.9.4 — CQRS/ES framework (command handling, event sourcing, query dispatching)
- Jackson (Kotlin module) — JSON serialization/deserialization

## Infrastructure
- Amazon EKS — Kubernetes cluster (implied by manifests)
- Axon Server 2024.1.2 — Event store and message router (3-node cluster)
- Amazon EBS gp3 — Persistent volumes for Axon Server (data + events)
- AWS ALB — Application Load Balancer for Ingress (internal scheme)
- Amazon ECR — Container registry (referenced in deployment manifest)
- H2 Database — In-memory token/saga store (PoC only)

## Build Tools
- Gradle 8.7 — Build system (Kotlin DSL)
- Docker — Container build (multi-stage, amazoncorretto:17-alpine base)

## Testing Tools
- JUnit 5 (JUnit Platform) — Test runner
- Spring Boot Test — Integration test support
- Axon Test 4.9.4 — Aggregate and saga testing utilities

## Container Images
- `gradle:8.7-jdk17` — Builder stage
- `amazoncorretto:17-alpine` — Runtime stage
- `axoniq/axonserver:2024.1.2` — Axon Server
