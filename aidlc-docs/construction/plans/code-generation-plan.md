# Code Generation Plan

## Context
Generate all deployment infrastructure code for the Axon PoC loan originations application. This covers all 3 units since they are tightly integrated.

**Project Type**: Brownfield (existing application code, generating new infrastructure/CI/CD code)
**Workspace Root**: /Users/epatro/github/axon-poc
**Code Location**: Workspace root (cfn/, .github/workflows/, k8s/)

## Unit 1: CloudFormation Infrastructure

### Step 1: Create CloudFormation directory structure
- [x] Create `cfn/` directory at workspace root

### Step 2: Generate parent stack (cfn/parent-stack.yaml)
- [x] Root CloudFormation template that orchestrates nested stacks
- [x] Parameters: EnvironmentName, VpcCidr, NodeInstanceType, NodeGroupSize
- [x] Nested stack references to networking, eks-cluster, ecr, addons
- [x] Outputs: ClusterName, ECRRepositoryUri, DeployRoleArn

### Step 3: Generate networking stack (cfn/networking.yaml)
- [x] VPC (10.0.0.0/16)
- [x] 3 public subnets (10.0.1.0/24, 10.0.2.0/24, 10.0.3.0/24)
- [x] 3 private subnets (10.0.11.0/24, 10.0.12.0/24, 10.0.13.0/24)
- [x] Internet Gateway + attachment
- [x] NAT Gateway (single, in us-east-1a) + EIP
- [x] Route tables (public → IGW, private → NAT)
- [x] Subnet tags for EKS auto-discovery (kubernetes.io/role/elb, kubernetes.io/role/internal-elb)
- [x] Outputs: VpcId, PublicSubnetIds, PrivateSubnetIds

### Step 4: Generate EKS cluster stack (cfn/eks-cluster.yaml)
- [x] EKS Cluster (Kubernetes 1.29)
- [x] Cluster IAM Role (AmazonEKSClusterPolicy)
- [x] Node IAM Role (WorkerNodePolicy, CNI_Policy, ECR ReadOnly)
- [x] Managed Node Group (t3.large, desired 3, min 2, max 4)
- [x] Cluster Security Group
- [x] OIDC Provider for IRSA (from cluster OIDC issuer)
- [x] Outputs: ClusterName, ClusterEndpoint, ClusterOidcIssuer, OidcProviderArn

### Step 5: Generate ECR stack (cfn/ecr.yaml)
- [x] ECR Repository (axon-poc-loan-originations)
- [x] Lifecycle policy (keep last 10 images)
- [x] Outputs: RepositoryUri, RepositoryArn

### Step 6: Generate addons stack (cfn/addons.yaml)
- [x] EBS CSI Driver IAM Role (IRSA with OIDC trust)
- [x] EBS CSI Driver EKS Addon
- [x] ALB Controller IAM Role (IRSA with OIDC trust)
- [x] ALB Controller IAM Policy (inline, AWS-provided policy document)
- [x] Outputs: EbsCsiRoleArn, AlbControllerRoleArn

### Step 7: Generate GitHub OIDC resources (in parent-stack.yaml)
- [x] IAM OIDC Provider for token.actions.githubusercontent.com
- [x] Deploy Role with trust policy for GitHub repo (patrocinio/axon-poc)
- [x] Deploy Role permissions: ECR push, EKS describe, CloudFormation operations
- [x] Output: DeployRoleArn

## Unit 2: CI/CD Pipeline

### Step 8: Create GitHub Actions directory structure
- [x] Create `.github/workflows/` directory

### Step 9: Generate CI/CD workflow (.github/workflows/deploy.yml)
- [x] Trigger: push to main branch
- [x] Permissions: id-token: write, contents: read
- [x] Job: deploy
  - Step 1: Checkout code
  - Step 2: Configure AWS credentials (OIDC)
  - Step 3: Deploy CloudFormation stacks (aws cloudformation deploy for parent stack)
  - Step 4: Get CloudFormation outputs (ECR URI, cluster name)
  - Step 5: Login to ECR
  - Step 6: Set up JDK 17
  - Step 7: Build with Gradle (bootJar)
  - Step 8: Build Docker image
  - Step 9: Tag and push to ECR
  - Step 10: Update kubeconfig for EKS
  - Step 11: Install ALB Controller via Helm (if not exists)
  - Step 12: Apply K8s manifests (kubectl apply)

## Unit 3: K8s Manifest Updates

### Step 10: Update k8s/loan-app.yaml
- [x] Replace `<ECR_REPO>/axon-poc-loan-originations:latest` with a sed-friendly placeholder that CI/CD will substitute
- [x] Use `IMAGE_PLACEHOLDER` that the GitHub Actions workflow replaces at deploy time with actual ECR URI + tag

### Step 11: Generate code summary documentation
- [x] Create `aidlc-docs/construction/cloudformation-infrastructure/code/code-summary.md`
- [x] Document all generated files, their purposes, and relationships
