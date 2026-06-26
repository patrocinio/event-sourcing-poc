#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GlobalStack } from './stacks/global-stack';
import { RegionalStack } from './stacks/regional-stack';

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const primaryRegion = 'us-east-1';
const secondaryRegion = 'us-west-2';
const domainName = app.node.tryGetContext('domainName') || '';

// Global resources (Route53, DynamoDB Global Table) — deployed in primary region
const globalStack = new GlobalStack(app, 'LoanOriginationsGlobal', {
  env: { account, region: primaryRegion },
  primaryRegion,
  secondaryRegion,
  domainName,
});

// Regional stack — primary (us-east-1)
const primaryStack = new RegionalStack(app, 'LoanOriginationsPrimary', {
  env: { account, region: primaryRegion },
  regionLabel: 'primary',
  globalTable: globalStack.globalTable,
  isPrimary: true,
});
primaryStack.addDependency(globalStack);

// Regional stack — secondary (us-west-2)
const secondaryStack = new RegionalStack(app, 'LoanOriginationsSecondary', {
  env: { account, region: secondaryRegion },
  regionLabel: 'secondary',
  globalTable: globalStack.globalTable,
  isPrimary: false,
});
secondaryStack.addDependency(globalStack);

app.synth();
