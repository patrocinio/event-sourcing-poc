# Infrastructure Design Plan

## Context
Design the AWS infrastructure for deploying the Axon PoC loan originations application to EKS. This covers all 3 units holistically since they share the same infrastructure target.

## Plan Steps

- [x] Design VPC and networking topology
- [x] Design EKS cluster configuration
- [x] Design ECR repository setup
- [x] Design EKS addons (EBS CSI, ALB Controller)
- [x] Design GitHub Actions OIDC integration for AWS access
- [x] Document deployment architecture diagram
- [x] Validate against requirements

## Questions

## Question 1
What EKS node instance type should be used for the PoC?

A) t3.medium (2 vCPU, 4 GiB) — smallest viable for EKS workloads

B) t3.large (2 vCPU, 8 GiB) — more headroom for Axon Server memory requirements

C) m5.large (2 vCPU, 8 GiB) — general purpose, no burstable limits

D) Other (please describe after [Answer]: tag below)

[Answer]: B

## Question 2
How many nodes should the managed node group have?

A) 2 nodes (minimum for multi-AZ, tight on resources for 3 Axon Server + 2 app pods)

B) 3 nodes (one per AZ, good fit for Axon Server topology spread)

C) 4 nodes (comfortable headroom)

D) Other (please describe after [Answer]: tag below)

[Answer]: B

## Question 3
How should GitHub Actions authenticate to AWS?

A) OIDC federation (recommended — no long-lived credentials, GitHub identity provider trusted by IAM role)

B) IAM user access keys stored as GitHub Secrets (simpler but less secure)

C) Other (please describe after [Answer]: tag below)

[Answer]: A

