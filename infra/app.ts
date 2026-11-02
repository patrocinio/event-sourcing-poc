#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PRIMARY_REGION, SECONDARY_REGION } from './config';
import { AuroraPrimaryStack } from './stacks/aurora-primary-stack';
import { AuroraSecondaryStack } from './stacks/aurora-secondary-stack';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

// Aurora Global Database across two regions:
//   primary   (us-east-1): writer + reader, global cluster, Kinesis, projector, migration
//   secondary (us-west-2): read-only replicas with global write forwarding
// Both regions run the full API. Shared resources use fixed physical names
// (see config.ts), so no cross-region CloudFormation references are needed.
// Stack names are distinct from the aws-native stacks
// (LoanOriginationsPrimary/Secondary/Global) so both can live in one account.
const primary = new AuroraPrimaryStack(app, 'LoanOriginationsAuroraPrimary', {
  env: { account, region: PRIMARY_REGION },
  nameSuffix: 'aurora-primary',
  secondaryRegion: SECONDARY_REGION,
});

const secondary = new AuroraSecondaryStack(app, 'LoanOriginationsAuroraSecondary', {
  env: { account, region: SECONDARY_REGION },
  nameSuffix: 'aurora-secondary',
  primaryRegion: PRIMARY_REGION,
});

// The secondary cluster joins the global cluster and reads the replicated
// secret, both created by the primary stack. CDK deploys primary first and
// destroys secondary first.
secondary.addDependency(primary);

app.synth();
