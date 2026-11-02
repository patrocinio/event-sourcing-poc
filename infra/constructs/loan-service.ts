import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct, IDependable } from 'constructs';
import * as path from 'path';
import { DB_NAME } from '../config';

const SRC = path.join(__dirname, '../../src');

/** Inputs for the database environment shared by every Lambda in a region. */
export interface DbEnvProps {
  /** Endpoint for writes (primary: cluster endpoint; secondary: write-forwarding cluster endpoint). */
  readonly writerHost: string;
  /** Region-local reader endpoint (query side + health). */
  readonly readerHost: string;
  /** Secrets Manager ARN of the credentials in THIS region. */
  readonly secretArn: string;
  /** Secondary region: enable session-consistent global write forwarding in src/shared/db.ts. */
  readonly writeForwarding?: boolean;
}

export function dbEnvironment(props: DbEnvProps): Record<string, string> {
  const env: Record<string, string> = {
    DB_WRITER_HOST: props.writerHost,
    DB_READER_HOST: props.readerHost,
    DB_SECRET_ARN: props.secretArn,
    DB_NAME,
    DB_POOL_MAX: '2', // one request per execution environment; keeps total connections bounded
    // Node 20 Lambda runtime ships the Amazon RDS CA bundle here; pg verifies against it.
    NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
  };
  if (props.writeForwarding) env.DB_WRITE_FORWARDING = 'true';
  return env;
}

export interface LoanFunctionOptions {
  readonly entry: string; // relative to src/, e.g. 'commands/handler.ts'
  readonly functionName: string;
  readonly timeout: cdk.Duration;
  readonly memorySize?: number;
  readonly environment?: Record<string, string>;
}

/**
 * Builds VPC-attached Node 20 Lambdas with identical runtime, tracing, logging,
 * bundling and DB environment. The secret read grant is applied to every
 * function it creates.
 */
export class LoanFunctionFactory {
  constructor(
    private readonly scope: Construct,
    private readonly props: {
      vpc: ec2.IVpc;
      securityGroup: ec2.ISecurityGroup;
      dbEnv: Record<string, string>;
      dbSecret: secretsmanager.ISecret;
    }
  ) {}

  create(id: string, opts: LoanFunctionOptions): nodejs.NodejsFunction {
    const fn = new nodejs.NodejsFunction(this.scope, id, {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: opts.memorySize ?? 512,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.THREE_MONTHS,
      vpc: this.props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.props.securityGroup],
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
        // pg optionally requires the native binding; we use the pure-JS client.
        externalModules: ['@aws-sdk/*', 'pg-native'],
      },
      entry: path.join(SRC, opts.entry),
      handler: 'handler',
      functionName: opts.functionName,
      timeout: opts.timeout,
      environment: { ...this.props.dbEnv, ...(opts.environment ?? {}) },
    });
    this.props.dbSecret.grantRead(fn);
    return fn;
  }
}

export interface LoanServiceProps {
  /** Physical-name suffix, e.g. 'aurora-primary' / 'aurora-secondary'. */
  readonly nameSuffix: string;
  readonly functions: LoanFunctionFactory;
  /** Extra env for the command Lambda (Kinesis stream name / region). */
  readonly commandEnvironment: Record<string, string>;
  /** Resources every API Lambda must wait for (schema migration, DB instances). */
  readonly dependsOn: IDependable[];
}

/**
 * Regional API surface, identical in both regions: command / query / health
 * Lambdas, provisioned-concurrency aliases, IAM-authenticated REST API and a
 * regional WAF web ACL.
 */
export class LoanService extends Construct {
  readonly commandHandler: nodejs.NodejsFunction;
  readonly queryHandler: nodejs.NodejsFunction;
  readonly healthHandler: nodejs.NodejsFunction;
  readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: LoanServiceProps) {
    super(scope, id);
    const suffix = props.nameSuffix;
    const stack = cdk.Stack.of(this);

    // Command Handler (writes go to DB_WRITER_HOST)
    this.commandHandler = props.functions.create('CommandHandler', {
      entry: 'commands/handler.ts',
      functionName: `loan-command-${suffix}`,
      timeout: cdk.Duration.seconds(10),
      environment: { ...props.commandEnvironment, AWS_REGION_LABEL: suffix },
    });
    const commandAlias = this.commandHandler.addAlias('live', {
      provisionedConcurrentExecutions: 50,
    });

    // Query Handler (region-local reader endpoint only)
    this.queryHandler = props.functions.create('QueryHandler', {
      entry: 'queries/handler.ts',
      functionName: `loan-query-${suffix}`,
      timeout: cdk.Duration.seconds(5),
    });
    const queryAlias = this.queryHandler.addAlias('live', {
      provisionedConcurrentExecutions: 50,
    });

    // Health Handler (SELECT 1 on the region-local reader)
    this.healthHandler = props.functions.create('HealthHandler', {
      entry: 'health/handler.ts',
      functionName: `loan-health-${suffix}`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
    });

    for (const fn of [this.commandHandler, this.queryHandler, this.healthHandler]) {
      for (const dep of props.dependsOn) fn.node.addDependency(dep);
    }

    // ========== API GATEWAY (IAM auth) + WAF ==========
    this.api = new apigateway.RestApi(this, 'LoanApi', {
      restApiName: `Loan API (${suffix})`,
      description: `CQRS/ES Loan API - Aurora PostgreSQL - ${suffix} (${stack.region})`,
      deployOptions: {
        stageName: 'prod',
        tracingEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        metricsEnabled: true,
        throttlingRateLimit: 1000,
        throttlingBurstLimit: 2000,
      },
      // Every method requires a SigV4-signed request from a principal with
      // execute-api:Invoke (CORS preflight OPTIONS mocks stay unauthenticated,
      // as browsers never sign preflights; they return no data).
      defaultMethodOptions: {
        authorizationType: apigateway.AuthorizationType.IAM,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // WAF Web ACL — rate limiting + managed rule sets
    const webAcl = new wafv2.CfnWebACL(this, 'ApiWaf', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `loan-api-waf-${suffix}`,
      },
      rules: [
        {
          name: 'RateLimit',
          priority: 1,
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimit',
          },
          statement: {
            rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' },
          },
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSet',
          },
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' },
          },
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 3,
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'KnownBadInputs',
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'ApiWafAssociation', {
      resourceArn: this.api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });

    // API Routes (aliases for provisioned concurrency)
    const commandIntegration = new apigateway.LambdaIntegration(commandAlias);
    const queryIntegration = new apigateway.LambdaIntegration(queryAlias);
    const healthIntegration = new apigateway.LambdaIntegration(this.healthHandler);

    const loansResource = this.api.root.addResource('api').addResource('loans');
    loansResource.addMethod('POST', commandIntegration);
    loansResource.addMethod('GET', queryIntegration);

    const loanByIdResource = loansResource.addResource('{id}');
    loanByIdResource.addMethod('GET', queryIntegration);
    loanByIdResource.addResource('approve').addMethod('POST', commandIntegration);
    loanByIdResource.addResource('reject').addMethod('POST', commandIntegration);
    loanByIdResource.addResource('disburse').addMethod('POST', commandIntegration);

    loansResource
      .addResource('status')
      .addResource('{status}')
      .addMethod('GET', queryIntegration);

    loansResource.addResource('health').addMethod('GET', healthIntegration);
  }
}
