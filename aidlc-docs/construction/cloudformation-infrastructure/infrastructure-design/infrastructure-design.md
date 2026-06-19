# Infrastructure Design — CloudFormation Infrastructure (Unit 1)

## Overview
AWS infrastructure provisioned via nested CloudFormation stacks in us-east-1 to host the Axon PoC loan originations application on EKS.

## CloudFormation Stack Architecture

```
parent-stack.yaml (root)
├── networking.yaml     → VPC, subnets, IGW, NAT, routes
├── eks-cluster.yaml    → EKS cluster, node group, IAM
├── ecr.yaml            → ECR repository
└── addons.yaml         → EBS CSI driver, ALB Controller IRSA
```

## Service Mapping

### Networking (networking.yaml)
| Resource | Service | Configuration |
|----------|---------|---------------|
| VPC | AWS::EC2::VPC | CIDR 10.0.0.0/16 |
| Public Subnets (3) | AWS::EC2::Subnet | 10.0.1.0/24, 10.0.2.0/24, 10.0.3.0/24 (us-east-1a, 1b, 1c) |
| Private Subnets (3) | AWS::EC2::Subnet | 10.0.11.0/24, 10.0.12.0/24, 10.0.13.0/24 |
| Internet Gateway | AWS::EC2::InternetGateway | For public subnet internet access |
| NAT Gateway | AWS::EC2::NatGateway | Single NAT (PoC — cost savings) in us-east-1a |
| Route Tables | AWS::EC2::RouteTable | Public → IGW, Private → NAT |

### EKS Cluster (eks-cluster.yaml)
| Resource | Service | Configuration |
|----------|---------|---------------|
| EKS Cluster | AWS::EKS::Cluster | Kubernetes 1.29, private subnets |
| Node Group | AWS::EKS::Nodegroup | t3.large, 3 nodes (desired/min/max: 3/2/4) |
| Cluster Role | AWS::IAM::Role | AmazonEKSClusterPolicy |
| Node Role | AWS::IAM::Role | AmazonEKSWorkerNodePolicy, AmazonEKS_CNI_Policy, AmazonEC2ContainerRegistryReadOnly |
| Cluster SG | AWS::EC2::SecurityGroup | Allow node ↔ control plane communication |

### Container Registry (ecr.yaml)
| Resource | Service | Configuration |
|----------|---------|---------------|
| ECR Repository | AWS::ECR::Repository | axon-poc-loan-originations, image tag mutability: MUTABLE, scan on push: false (PoC) |

### Addons (addons.yaml)
| Resource | Service | Configuration |
|----------|---------|---------------|
| EBS CSI Driver | AWS::EKS::Addon | aws-ebs-csi-driver, IRSA service account |
| EBS CSI IAM Role | AWS::IAM::Role | AmazonEBSCSIDriverPolicy, OIDC trust |
| ALB Controller IAM Role | AWS::IAM::Role | Custom policy for ALB management, OIDC trust |

### GitHub Actions OIDC (in parent-stack or addons)
| Resource | Service | Configuration |
|----------|---------|---------------|
| OIDC Provider | AWS::IAM::OIDCProvider | token.actions.githubusercontent.com |
| Deploy Role | AWS::IAM::Role | Trust: GitHub OIDC, Permissions: ECR push, EKS describe/update, CloudFormation deploy |

## Key Design Decisions

1. **Single NAT Gateway**: PoC cost optimization. Production would use one NAT per AZ.
2. **3 Nodes across 3 AZs**: Matches Axon Server topology spread constraint (one pod per AZ for Raft quorum).
3. **t3.large**: 8 GiB memory per node supports Axon Server's 2Gi limit + app's 1Gi limit comfortably.
4. **OIDC Federation**: No long-lived AWS credentials in GitHub. IAM role assumed via short-lived token.
5. **Nested Stacks**: Clean separation of concerns, reusable templates, clear dependency ordering.

## Outputs (Cross-Stack References)

| Stack | Output | Consumed By |
|-------|--------|-------------|
| networking | VpcId, PrivateSubnetIds, PublicSubnetIds | eks-cluster, addons |
| eks-cluster | ClusterName, ClusterOidcIssuer, NodeRoleArn | addons, GitHub Actions |
| ecr | RepositoryUri | GitHub Actions workflow, K8s manifests |
| addons | EbsCsiRoleArn, AlbControllerRoleArn | EKS addon configuration |
| parent | DeployRoleArn | GitHub Actions OIDC |
