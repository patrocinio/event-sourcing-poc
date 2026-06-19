# Integration Test Instructions

## Purpose
Test the full deployment pipeline end-to-end: CloudFormation provisioning, Docker build, ECR push, and Kubernetes deployment.

## Test Scenarios

### Scenario 1: First-Time Infrastructure Provisioning
- **Description**: Deploy CloudFormation stacks from scratch to verify all resources are created correctly
- **Setup**: Clean AWS account with no existing axon-poc stacks
- **Test Steps**:
  1. Create S3 bucket for templates: `aws s3 mb s3://axon-poc-cfn-templates --region us-east-1`
  2. Upload templates: `aws s3 sync cfn/ s3://axon-poc-cfn-templates/`
  3. Deploy parent stack:
     ```bash
     aws cloudformation deploy \
       --template-file cfn/parent-stack.yaml \
       --stack-name axon-poc \
       --parameter-overrides \
         EnvironmentName=axon-poc \
         TemplatesBucketName=axon-poc-cfn-templates \
       --capabilities CAPABILITY_NAMED_IAM \
       --region us-east-1
     ```
  4. Wait for stack completion (15-25 minutes)
  5. Verify outputs:
     ```bash
     aws cloudformation describe-stacks --stack-name axon-poc \
       --query "Stacks[0].Outputs" --output table
     ```
- **Expected Results**:
  - Stack status: CREATE_COMPLETE
  - Outputs: ClusterName, ECRRepositoryUri, DeployRoleArn, VpcId
  - EKS cluster visible: `aws eks list-clusters --region us-east-1`
  - ECR repo exists: `aws ecr describe-repositories --region us-east-1`
- **Cleanup**: `aws cloudformation delete-stack --stack-name axon-poc` (destroys all resources)

### Scenario 2: Application Build and Deploy to EKS
- **Description**: Build app, push to ECR, deploy to EKS, verify pods are running
- **Setup**: CloudFormation stacks must be deployed (Scenario 1 complete)
- **Test Steps**:
  1. Get ECR URI:
     ```bash
     ECR_URI=$(aws cloudformation describe-stacks --stack-name axon-poc \
       --query "Stacks[0].Outputs[?OutputKey=='ECRRepositoryUri'].OutputValue" \
       --output text)
     ```
  2. Build and push:
     ```bash
     aws ecr get-login-password --region us-east-1 | \
       docker login --username AWS --password-stdin $ECR_URI
     docker build -t $ECR_URI:test .
     docker push $ECR_URI:test
     ```
  3. Configure kubectl:
     ```bash
     CLUSTER_NAME=$(aws cloudformation describe-stacks --stack-name axon-poc \
       --query "Stacks[0].Outputs[?OutputKey=='ClusterName'].OutputValue" \
       --output text)
     aws eks update-kubeconfig --name $CLUSTER_NAME --region us-east-1
     ```
  4. Deploy K8s resources:
     ```bash
     kubectl apply -f k8s/storage-class.yaml
     kubectl apply -f k8s/axon-server.yaml
     sed "s|<ECR_REPO>/axon-poc-loan-originations:latest|${ECR_URI}:test|g" \
       k8s/loan-app.yaml | kubectl apply -f -
     ```
  5. Verify deployment:
     ```bash
     kubectl get pods -n axon-poc
     kubectl rollout status deployment/loan-originations-poc -n axon-poc --timeout=300s
     ```
- **Expected Results**:
  - 3 Axon Server pods running (StatefulSet)
  - 2 loan-originations-poc pods running (Deployment)
  - All pods in `Running` state
  - Health endpoints responding:
    ```bash
    kubectl port-forward svc/loan-originations-poc -n axon-poc 8080:80
    curl http://localhost:8080/actuator/health
    ```
- **Cleanup**: `kubectl delete namespace axon-poc`

### Scenario 3: CI/CD Pipeline End-to-End
- **Description**: Push to main triggers full automated deployment
- **Setup**:
  - GitHub Actions OIDC configured
  - `AWS_DEPLOY_ROLE_ARN` secret set in GitHub repo settings
- **Test Steps**:
  1. Make a minor change (e.g., update README)
  2. Commit and push to main
  3. Monitor GitHub Actions workflow execution
  4. Verify all steps pass
- **Expected Results**:
  - Workflow completes successfully (green check)
  - New image pushed to ECR with commit SHA tag
  - Pods updated with new image
  - Application responding to requests

## Smoke Test (Post-Deployment)

After successful deployment, verify the application works:

```bash
# Port-forward to test locally (or use ALB endpoint)
kubectl port-forward svc/loan-originations-poc -n axon-poc 8080:80 &

# Submit a loan application
curl -X POST http://localhost:8080/api/loans \
  -H "Content-Type: application/json" \
  -d '{"applicantName": "Test User", "requestedAmount": 10000, "purpose": "PoC Test"}'

# Query all loans
curl http://localhost:8080/api/loans
```

**Expected**: 201 Created response with loanId and status "SUBMITTED", then GET returns the loan in the list.
