#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AuroraStack } from './stacks/aurora-stack';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

// Single region: an Aurora cluster has one writer (Global Database secondaries
// are read-only), so the aurora branch drops active-active multi-region.
// The stack name is distinct from the aws-native stacks
// (LoanOriginationsPrimary/Secondary/Global) so both can live in one account.
new AuroraStack(app, 'LoanOriginationsAurora', {
  env: { account, region: 'us-east-1' },
  nameSuffix: 'aurora',
});

app.synth();
