# Units of Work

## Unit 1: CloudFormation Infrastructure
**Type**: Infrastructure-as-Code
**Responsibility**: Provision all AWS resources needed to run the application

### Scope
- Parent CloudFormation stack with nested child stacks
- Child stacks:
  - **Networking**: VPC, subnets (public/private), Internet Gateway, NAT Gateway, route tables
  - **Cluster**: EKS cluster, managed node group, IAM roles (cluster + node), security groups
  - **Registry**: ECR repository for application images
  - **Addons**: EBS CSI driver, AWS Load Balancer Controller IAM role/policy
- Region: us-east-1
- PoC-level sizing (smallest viable instances)

### Deliverables
- `cfn/parent-stack.yaml` — Parent/root stack orchestrating nested stacks
- `cfn/networking.yaml` — VPC and networking resources
- `cfn/eks-cluster.yaml` — EKS cluster and node group
- `cfn/ecr.yaml` — ECR repository
- `cfn/addons.yaml` — EKS addons (EBS CSI, ALB Controller)

---

## Unit 2: CI/CD Pipeline (GitHub Actions)
**Type**: Automation
**Responsibility**: Fully automated pipeline that provisions infrastructure, builds app, pushes image, and deploys to EKS

### Scope
- Single GitHub Actions workflow triggered on push to main
- Steps:
  1. Provision/update CloudFormation stacks (idempotent)
  2. Build Spring Boot application (Gradle)
  3. Build Docker image
  4. Push image to ECR
  5. Configure kubectl for EKS
  6. Apply Kubernetes manifests
- AWS credentials via GitHub OIDC or secrets

### Deliverables
- `.github/workflows/deploy.yml` — Full CI/CD workflow

---

## Unit 3: Kubernetes Manifest Updates
**Type**: Configuration
**Responsibility**: Update existing K8s manifests to work with provisioned infrastructure

### Scope
- Replace `<ECR_REPO>` placeholder in `k8s/loan-app.yaml` with dynamic ECR URI
- Ensure manifests reference the correct namespace, image tag, and service DNS
- Validate manifests are compatible with provisioned EKS version

### Deliverables
- Updated `k8s/loan-app.yaml` — with ECR URI parameterized for CI/CD
- No changes to `k8s/axon-server.yaml` or `k8s/storage-class.yaml` (already correct)
