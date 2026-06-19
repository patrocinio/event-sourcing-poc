# Unit of Work Plan

## Context
Decompose the deployment work into manageable units. The application code is complete — this is purely infrastructure and automation work.

## Plan Steps

- [x] Define units of work with clear boundaries and responsibilities
- [x] Define unit dependencies and execution sequence
- [x] Map requirements to units
- [x] Validate unit boundaries

## Questions

## Question 1
How should the CloudFormation stacks be organized?

A) Single monolithic template with all resources (VPC, EKS, ECR, IAM, addons)

B) Nested stacks — a parent stack with child stacks for each logical grouping (networking, cluster, registry, addons)

C) Separate independent stacks deployed in sequence (VPC stack, EKS stack, ECR stack, addons stack)

D) Other (please describe after [Answer]: tag below)

[Answer]: B

## Question 2
Should the GitHub Actions CI/CD pipeline include infrastructure provisioning, or only application build+deploy?

A) Full pipeline — provisions infrastructure AND builds/deploys app (single workflow)

B) Separate workflows — one for infrastructure provisioning (manual trigger), another for app build+deploy (on push)

C) Infrastructure provisioned manually via CLI, CI/CD only handles app build+deploy

D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 3
What AWS region should the infrastructure be deployed to?

A) us-east-1 (N. Virginia)

B) us-west-2 (Oregon)

C) eu-west-1 (Ireland)

D) Other (please describe after [Answer]: tag below)

[Answer]: A

