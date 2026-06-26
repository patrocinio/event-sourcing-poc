#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from './stacks/network-stack';
import { DataStack } from './stacks/data-stack';
import { ComputeStack } from './stacks/compute-stack';
import { ApiStack } from './stacks/api-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

const networkStack = new NetworkStack(app, 'LoanOriginationsNetwork', { env });

const dataStack = new DataStack(app, 'LoanOriginationsData', {
  env,
  vpc: networkStack.vpc,
  privateSubnets: networkStack.privateSubnets,
  lambdaSecurityGroup: networkStack.lambdaSecurityGroup,
});

const computeStack = new ComputeStack(app, 'LoanOriginationsCompute', {
  env,
  vpc: networkStack.vpc,
  privateSubnets: networkStack.privateSubnets,
  lambdaSecurityGroup: networkStack.lambdaSecurityGroup,
  eventTable: dataStack.eventTable,
  kinesisStream: dataStack.kinesisStream,
  redisEndpoint: dataStack.redisEndpoint,
  redisPort: dataStack.redisPort,
});

new ApiStack(app, 'LoanOriginationsApi', {
  env,
  commandHandler: computeStack.commandHandler,
  queryHandler: computeStack.queryHandler,
  healthHandler: computeStack.healthHandler,
});

app.synth();
