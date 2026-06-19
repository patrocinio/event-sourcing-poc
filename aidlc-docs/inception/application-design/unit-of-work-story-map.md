# Unit of Work — Requirements Mapping

Since User Stories were skipped, this maps functional requirements (from requirements.md) to units.

## Requirements to Unit Mapping

| Requirement | Unit | Notes |
|-------------|------|-------|
| FR-1: Infrastructure as Code (CloudFormation) | Unit 1 | Core responsibility of Unit 1 |
| FR-2: Container Image Build and Push | Unit 2 | CI/CD pipeline handles build + push to ECR |
| FR-3: CI/CD Pipeline (GitHub Actions) | Unit 2 | Core responsibility of Unit 2 |
| FR-4: Kubernetes Deployment | Unit 2 + Unit 3 | CI/CD applies manifests; Unit 3 updates them |
| FR-5: Update Existing K8s Manifests | Unit 3 | Core responsibility of Unit 3 |

## Coverage Verification

- **FR-1**: ✅ Covered by Unit 1
- **FR-2**: ✅ Covered by Unit 2
- **FR-3**: ✅ Covered by Unit 2
- **FR-4**: ✅ Covered by Unit 2 (deploy step) + Unit 3 (manifest content)
- **FR-5**: ✅ Covered by Unit 3

All functional requirements are mapped to at least one unit. No gaps identified.
