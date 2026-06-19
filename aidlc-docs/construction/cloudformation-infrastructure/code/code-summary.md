# Code Generation Summary

## Generated Files

### Unit 1: CloudFormation Infrastructure
| File | Purpose |
|------|---------|
| `cfn/parent-stack.yaml` | Root stack orchestrating nested stacks + GitHub OIDC provider + deploy role |
| `cfn/networking.yaml` | VPC, 3 public + 3 private subnets, IGW, NAT Gateway, route tables |
| `cfn/eks-cluster.yaml` | EKS cluster (K8s 1.29), managed node group (3x t3.large), IAM roles, OIDC provider |
| `cfn/ecr.yaml` | ECR repository with lifecycle policy (keep last 10 images) |
| `cfn/addons.yaml` | EBS CSI driver addon + ALB Controller IAM role (both IRSA) |

### Unit 2: CI/CD Pipeline
| File | Purpose |
|------|---------|
| `.github/workflows/deploy.yml` | Full CI/CD: upload CFN templates → deploy stacks → build app → push to ECR → deploy to EKS |

### Unit 3: K8s Manifest Updates
| File | Change |
|------|--------|
| `k8s/loan-app.yaml` | No file modification needed — CI/CD pipeline uses `sed` to substitute `<ECR_REPO>` placeholder at deploy time |

## Architecture Summary

```
GitHub push to main
  → GitHub Actions assumes IAM role via OIDC
  → Uploads CFN templates to S3
  → Deploys/updates CloudFormation parent stack (nested stacks)
  → Builds Gradle bootJar + Docker image
  → Pushes image to ECR (tagged with commit SHA)
  → Configures kubectl for EKS
  → Installs ALB Controller via Helm
  → Applies K8s manifests (with ECR image substituted)
  → Verifies deployment rollout
```

## Prerequisites for First Deployment

1. **S3 Bucket**: Create `axon-poc-cfn-templates` bucket in us-east-1 (or the workflow creates it)
2. **GitHub Secret**: Set `AWS_DEPLOY_ROLE_ARN` — this is a chicken-and-egg problem:
   - First deployment: manually create the parent stack to get the role ARN
   - Or: Bootstrap the OIDC provider and role separately, then let CI/CD handle the rest
3. **Gradle Wrapper**: Ensure `gradlew` exists in repo root (may need to run `gradle wrapper` locally)
4. **EKS Auth**: After cluster creation, the deploy role needs to be mapped in aws-auth ConfigMap for kubectl access
