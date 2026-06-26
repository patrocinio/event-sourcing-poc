# Requirements Verification Questions

Please answer each question by placing your letter choice after the [Answer]: tag.

## Question 1
What programming language should the AWS-native solution use?

A) TypeScript (Lambda with Node.js runtime — fast cold starts, popular for serverless)

B) Python (Lambda with Python runtime — concise, AWS SDK support, data processing)

C) Kotlin (same as existing solution — reuse domain knowledge)

D) Java (familiar ecosystem, but slower Lambda cold starts)

E) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 2
What AWS services should handle the Event Store (replacing Axon Server)?

A) DynamoDB (single-table design for events + snapshots — fast, serverless, cost-effective)

B) EventBridge + DynamoDB (EventBridge for event routing, DynamoDB for persistence)

C) Kinesis Data Streams + DynamoDB (Kinesis for ordered event streaming, DynamoDB for storage)

D) DynamoDB Streams + DynamoDB (native change capture for projections)

E) Other (please describe after [Answer]: tag below)

[Answer]: C

## Question 3
What should serve as the API layer (replacing Spring Boot REST)?

A) API Gateway (REST) + Lambda (standard REST API with Lambda backend)

B) API Gateway (HTTP API) + Lambda (lighter, cheaper, faster than REST API)

C) AppSync (GraphQL) + Lambda (if you want GraphQL instead of REST)

D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 4
How should the read model (projection) be maintained?

A) DynamoDB Streams → Lambda → separate DynamoDB table (event-driven, serverless)

B) EventBridge → Lambda → DynamoDB (decoupled event bus)

C) DynamoDB Streams → Lambda → ElastiCache/Redis (low-latency reads)

D) Other (please describe after [Answer]: tag below)

[Answer]: C

## Question 5
What IaC tool should define the infrastructure?

A) AWS CDK (TypeScript) — programmatic, type-safe, good for complex infra

B) AWS SAM (YAML) — simpler, purpose-built for serverless

C) CloudFormation (YAML) — same as current networking/EKS stacks

D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 6
Should the solution include a demo script similar to the Axon PoC?

A) Yes — interactive bash script demonstrating CQRS/ES with AWS services

B) Yes — plus a Postman/Bruno collection for API testing

C) No — just the implementation code and IaC

D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 7
What level of deployment automation is needed?

A) Full CI/CD with GitHub Actions (build, test, deploy on push)

B) Manual deployment scripts (deploy.sh with AWS CLI/CDK commands)

C) Both (CI/CD pipeline + manual deployment option)

D) Other (please describe after [Answer]: tag below)

[Answer]: A
