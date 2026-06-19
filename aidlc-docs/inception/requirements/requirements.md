# Requirements Document

## Intent Analysis

- **User Request**: Deploy this solution (Axon Framework loan originations PoC)
- **Request Type**: Deployment / Infrastructure provisioning
- **Scope Estimate**: System-wide — infrastructure-as-code, CI/CD pipeline, container registry, EKS cluster
- **Complexity Estimate**: Moderate — well-understood patterns (EKS + ECR + GitHub Actions) but multiple AWS services to orchestrate
- **Quality Level**: PoC-level — minimal configuration, quick to get running, acceptable shortcuts

## Functional Requirements

### FR-1: Infrastructure as Code (CloudFormation)
Provision all required AWS infrastructure using AWS CloudFormation:
- EKS cluster (managed node group)
- ECR repository for the application image
- VPC with public and private subnets
- Security groups for cluster and node communication
- IAM roles for EKS, nodes, and service accounts
- EBS CSI driver addon (for Axon Server persistent volumes)
- AWS Load Balancer Controller (for ALB Ingress)

### FR-2: Container Image Build and Push
- Build the application Docker image
- Push to Amazon ECR
- Tag with commit SHA and/or `latest`

### FR-3: CI/CD Pipeline (GitHub Actions)
Fully automated pipeline triggered on push to main:
1. Build the Spring Boot application (Gradle)
2. Run tests (if any)
3. Build Docker image
4. Push image to ECR
5. Deploy to EKS (update Kubernetes manifests with new image tag)

### FR-4: Kubernetes Deployment
Deploy application and dependencies to EKS:
- Axon Server (3-node StatefulSet using existing manifest)
- Loan Originations application (2-replica Deployment)
- Services and Ingress (ALB)
- StorageClass (gp3)
- Namespace: `axon-poc`

### FR-5: Update Existing K8s Manifests
- Replace `<ECR_REPO>` placeholder in `k8s/loan-app.yaml` with actual ECR repository URI
- Ensure manifests are compatible with provisioned cluster

## Non-Functional Requirements

### NFR-1: PoC Simplicity
- Minimize configuration complexity
- Use managed AWS services where possible (EKS managed node groups)
- Accept PoC-level shortcuts (no TLS, no custom domain, no secrets rotation)
- Single-region deployment

### NFR-2: Cost Efficiency (PoC)
- Use smallest viable instance types
- Single managed node group
- No multi-AZ for application (Axon Server may still benefit from AZ spread for Raft quorum)

### NFR-3: Automation
- Zero manual steps after initial Terraform apply and GitHub Actions setup
- Subsequent code changes auto-deploy via CI/CD

## Constraints
- AWS account available, no existing EKS cluster
- Container registry: Amazon ECR
- CI/CD: GitHub Actions (repo hosted on GitHub)
- IaC tool: AWS CloudFormation (native AWS, no third-party tooling required)
- Quality: PoC-level — no security, resiliency, or PBT extensions enforced

## Out of Scope
- Production hardening (TLS, WAF, custom domains, secrets management)
- Multi-region or DR setup
- Monitoring and observability stack (CloudWatch, Prometheus, Grafana)
- Automated testing beyond what exists
- Security scanning (Trivy, Snyk)
- Cost optimization (spot instances, Karpenter)
