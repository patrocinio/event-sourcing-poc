# Unit Test Execution

## Overview
The application has test dependencies configured (Spring Boot Test, Axon Test) but no test classes written yet. This is acceptable for the PoC. The primary "tests" for this deployment project are CloudFormation template validation and workflow syntax checking.

## Run Application Tests (when tests exist)

### 1. Execute All Unit Tests
```bash
./gradlew test --no-daemon
```

### 2. Review Test Results
- **Expected**: 0 tests (no test classes written yet for PoC)
- **Test Report Location**: `build/reports/tests/test/index.html`
- **Status**: N/A (no tests written)

## Infrastructure Validation Tests

### 1. CloudFormation Template Validation
```bash
# Validate all templates pass AWS syntax checking
for template in cfn/*.yaml; do
  echo "=== Validating: $template ==="
  aws cloudformation validate-template \
    --template-body file://$template \
    --region us-east-1
  echo ""
done
```

**Expected**: Each template returns valid JSON with no errors.

### 2. CloudFormation Lint (cfn-lint)
```bash
# Install cfn-lint
pip install cfn-lint

# Lint all templates
cfn-lint cfn/*.yaml
```

**Expected**: No errors (warnings may be acceptable for PoC).

### 3. GitHub Actions Workflow Lint
```bash
# Install actionlint
brew install actionlint  # macOS
# or: go install github.com/rhysd/actionlint/cmd/actionlint@latest

# Validate workflow
actionlint .github/workflows/deploy.yml
```

**Expected**: No errors reported.

### 4. Kubernetes Manifest Validation
```bash
# Dry-run validation (requires kubectl configured)
kubectl apply --dry-run=client -f k8s/storage-class.yaml
kubectl apply --dry-run=client -f k8s/axon-server.yaml
kubectl apply --dry-run=client -f k8s/loan-app.yaml
```

**Expected**: All manifests pass dry-run validation.

## Test Summary
| Test Type | Status | Notes |
|-----------|--------|-------|
| Application unit tests | N/A | No tests written (PoC) |
| CloudFormation validation | To verify | Run `aws cloudformation validate-template` |
| CloudFormation lint | To verify | Run `cfn-lint` |
| GitHub Actions lint | To verify | Run `actionlint` |
| K8s manifest validation | To verify | Run `kubectl --dry-run=client` |
