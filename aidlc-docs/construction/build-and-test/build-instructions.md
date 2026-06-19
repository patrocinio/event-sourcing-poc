# Build Instructions

## Prerequisites
- **Build Tool**: Gradle 8.7+ (wrapper included in repo)
- **JDK**: Amazon Corretto 17 or OpenJDK 17
- **Docker**: Docker 24+ (for image builds)
- **AWS CLI**: v2 (for CloudFormation deployment)
- **kubectl**: 1.29+ (for Kubernetes operations)
- **Helm**: v3 (for ALB Controller installation)
- **System Requirements**: macOS/Linux, 4GB RAM, 2GB disk

## Build Steps

### 1. Generate Gradle Wrapper (if not present)
```bash
# Only needed once — the wrapper should be committed to repo
gradle wrapper --gradle-version 8.7
```

### 2. Build the Application
```bash
./gradlew bootJar --no-daemon
```

**Expected Output**:
- `BUILD SUCCESSFUL` message
- JAR artifact at: `build/libs/axon-poc-loan-originations-0.1.0-SNAPSHOT.jar`

### 3. Build Docker Image (locally)
```bash
docker build -t axon-poc-loan-originations:local .
```

**Expected Output**:
- Multi-stage build completes (builder + runtime stages)
- Image tagged as `axon-poc-loan-originations:local`

### 4. Validate CloudFormation Templates
```bash
# Validate each template
for template in cfn/*.yaml; do
  echo "Validating $template..."
  aws cloudformation validate-template --template-body file://$template
done
```

**Expected Output**: Each template returns a valid JSON response with parameters and description.

### 5. Validate GitHub Actions Workflow
```bash
# Install actionlint (optional but recommended)
# brew install actionlint
actionlint .github/workflows/deploy.yml
```

## Build Artifacts
| Artifact | Location |
|----------|----------|
| Application JAR | `build/libs/axon-poc-loan-originations-0.1.0-SNAPSHOT.jar` |
| Docker image | Local Docker registry |
| CloudFormation templates | `cfn/` directory (5 YAML files) |
| CI/CD workflow | `.github/workflows/deploy.yml` |
| K8s manifests | `k8s/` directory (3 YAML files) |

## Troubleshooting

### Build Fails with JDK Errors
- **Cause**: Wrong JDK version
- **Solution**: Install JDK 17 (`sdk install java 17.0.11-amzn` or `brew install openjdk@17`)

### Docker Build Fails at Gradle Stage
- **Cause**: Network issues pulling dependencies in builder stage
- **Solution**: Run `./gradlew bootJar` locally first to populate cache, or add `--build-arg` for proxy settings

### CloudFormation Validation Fails
- **Cause**: Syntax error in YAML templates
- **Solution**: Check the specific error message, fix YAML indentation or resource references
