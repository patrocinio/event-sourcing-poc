# Requirements Verification Questions

Your request is to **deploy this solution**. The existing codebase has Kubernetes manifests targeting EKS, but several deployment details need clarification. Please answer the following questions to help define the deployment requirements.

## Question 1
What is your deployment target environment?

A) AWS EKS (Elastic Kubernetes Service) — as suggested by existing k8s manifests

B) Local Kubernetes (minikube, kind, Docker Desktop)

C) Other cloud Kubernetes (GKE, AKS)

D) Docker Compose (simplified local deployment)

E) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 2
What is the scope of "deploy" for this request?

A) Generate CI/CD pipeline (GitHub Actions, CodePipeline) to automate build + push + deploy

B) Create deployment scripts/Makefile to deploy manually to an existing EKS cluster

C) Create full infrastructure-as-code (Terraform/CDK) to provision EKS cluster + deploy application

D) Fix the existing K8s manifests (fill in ECR_REPO placeholder, add missing config) so they are ready to apply

E) Other (please describe after [Answer]: tag below)

[Answer]: C

## Question 3
Do you already have an AWS account with an EKS cluster provisioned?

A) Yes — I have an existing EKS cluster ready to use

B) No — I need the cluster provisioned as part of this deployment

C) I have an AWS account but no EKS cluster yet

D) Other (please describe after [Answer]: tag below)

[Answer]: C

## Question 4
What container registry will you use for the application image?

A) Amazon ECR (Elastic Container Registry)

B) Docker Hub

C) GitHub Container Registry (ghcr.io)

D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 5
What level of automation do you want for the deployment process?

A) Fully automated CI/CD — push to main triggers build, test, and deploy

B) Semi-automated — CI builds and pushes image, manual kubectl apply for deployment

C) Manual — scripts and documentation to run deployment steps locally

D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 6
Should this deployment be production-grade or PoC-level?

A) PoC-level — minimal configuration, quick to get running, acceptable shortcuts

B) Production-ready — proper secrets management, monitoring, resource limits, TLS, etc.

C) Somewhere in between — production-like structure but simplified where possible

D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question: Security Extensions
Should security extension rules be enforced for this project?

A) Yes — enforce all SECURITY rules as blocking constraints (recommended for production-grade applications)

B) No — skip all SECURITY rules (suitable for PoCs, prototypes, and experimental projects)

X) Other (please describe after [Answer]: tag below)

[Answer]: B

## Question: Resiliency Extensions
Should the resiliency baseline be applied to this project?

A) Yes — apply the resiliency baseline as directional best practices and design-time guidance (recommended for business-critical workloads, as an informed starting point that you can validate and harden before go-live)

B) No — skip the resiliency baseline (suitable for PoCs, prototypes, and experimental projects where rapid iteration matters more than reliability)

X) Other (please describe after [Answer]: tag below)

[Answer]: B

## Question: Property-Based Testing Extension
Should property-based testing (PBT) rules be enforced for this project?

A) Yes — enforce all PBT rules as blocking constraints (recommended for projects with business logic, data transformations, serialization, or stateful components)

B) Partial — enforce PBT rules only for pure functions and serialization round-trips (suitable for projects with limited algorithmic complexity)

C) No — skip all PBT rules (suitable for simple CRUD applications, UI-only projects, or thin integration layers with no significant business logic)

X) Other (please describe after [Answer]: tag below)

[Answer]: C
