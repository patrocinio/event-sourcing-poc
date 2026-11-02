import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as crypto from 'crypto';
import * as path from 'path';
import { SCHEMA_STATEMENTS } from '../../src/migration/schema';

interface AuroraStackProps extends cdk.StackProps {
  /** Suffix for physical names (Lambda, Kinesis) so they never collide with other branches' stacks. */
  nameSuffix: string;
}

/**
 * Aurora Stack — single-region CQRS/ES on Aurora PostgreSQL Serverless v2.
 *
 * - Writer instance: event store (`events`) + projection writes (`loans`)
 * - Reader instance: query side (`loans` via the reader endpoint)
 * - Kinesis: event distribution; drives the projector
 * - API Gateway (IAM auth) + WAF, X-Ray tracing
 *
 * Aurora has exactly one writer per cluster, so this branch is single-region
 * (Global Database secondaries are read-only — no active-active writes).
 */
export class AuroraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuroraStackProps) {
    super(scope, id, props);
    const suffix = props.nameSuffix;

    // ========== NETWORKING (3 AZs) ==========
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways: 3, // One per AZ for HA
      subnetConfiguration: [
        { cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        // Database tier: no route to the internet in either direction.
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'Lambda functions security group',
      allowAllOutbound: true, // Kinesis / Secrets Manager via NAT, Aurora in-VPC
    });

    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'Aurora PostgreSQL - ingress only from Lambda SG on 5432',
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(lambdaSg, ec2.Port.tcp(5432), 'Lambda to Aurora PostgreSQL');

    // ========== DATA: Aurora PostgreSQL Serverless v2 ==========
    const dbName = 'loans';
    const cluster = new rds.DatabaseCluster(this, 'LoanDb', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      writer: rds.ClusterInstance.serverlessV2('writer'),
      readers: [rds.ClusterInstance.serverlessV2('reader', { scaleWithWriter: true })],
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
      credentials: rds.Credentials.fromGeneratedSecret('loanadmin'),
      defaultDatabaseName: dbName,
      storageEncrypted: true,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });
    const dbSecret = cluster.secret!;

    // Kinesis — event distribution (drives the projector + other consumers)
    const stream = new kinesis.Stream(this, 'EventStream', {
      streamName: `loan-events-${suffix}`,
      shardCount: 2,
      retentionPeriod: cdk.Duration.hours(168), // 7 days
    });

    // ========== COMPUTE ==========
    const dbEnv = {
      DB_WRITER_HOST: cluster.clusterEndpoint.hostname,
      DB_READER_HOST: cluster.clusterReadEndpoint.hostname,
      DB_SECRET_ARN: dbSecret.secretArn,
      DB_NAME: dbName,
      DB_POOL_MAX: '2', // one request per execution environment; keeps total connections bounded
      // Node 20 Lambda runtime ships the Amazon RDS CA bundle here; pg verifies against it.
      NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
    };

    const commonProps: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.THREE_MONTHS,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
        // pg optionally requires the native binding; we use the pure-JS client.
        externalModules: ['@aws-sdk/*', 'pg-native'],
      },
    };

    // Schema migration (custom resource → Provider → migration Lambda)
    const migrationHandler = new nodejs.NodejsFunction(this, 'MigrationHandler', {
      ...commonProps,
      entry: path.join(__dirname, '../../src/migration/handler.ts'),
      handler: 'handler',
      functionName: `loan-migration-${suffix}`,
      timeout: cdk.Duration.minutes(2),
      environment: { ...dbEnv },
    });
    dbSecret.grantRead(migrationHandler);

    const migrationProvider = new cr.Provider(this, 'MigrationProvider', {
      onEventHandler: migrationHandler,
      logRetention: logs.RetentionDays.THREE_MONTHS,
    });
    const schemaHash = crypto
      .createHash('sha256')
      .update(SCHEMA_STATEMENTS.join(';\n'))
      .digest('hex');
    const migration = new cdk.CustomResource(this, 'SchemaMigration', {
      serviceToken: migrationProvider.serviceToken,
      properties: { SchemaHash: schemaHash }, // re-run when the DDL changes
    });
    // Cluster (incl. writer instance) must be available before DDL runs.
    migration.node.addDependency(cluster);

    // Command Handler (writer: event store)
    const commandHandler = new nodejs.NodejsFunction(this, 'CommandHandler', {
      ...commonProps,
      entry: path.join(__dirname, '../../src/commands/handler.ts'),
      handler: 'handler',
      functionName: `loan-command-${suffix}`,
      timeout: cdk.Duration.seconds(10),
      environment: {
        ...dbEnv,
        KINESIS_STREAM_NAME: stream.streamName,
        AWS_REGION_LABEL: suffix,
      },
    });
    dbSecret.grantRead(commandHandler);
    stream.grantWrite(commandHandler);
    const commandAlias = commandHandler.addAlias('live', {
      provisionedConcurrentExecutions: 50,
    });

    // Query Handler (reader endpoint only)
    const queryHandler = new nodejs.NodejsFunction(this, 'QueryHandler', {
      ...commonProps,
      entry: path.join(__dirname, '../../src/queries/handler.ts'),
      handler: 'handler',
      functionName: `loan-query-${suffix}`,
      timeout: cdk.Duration.seconds(5),
      environment: { ...dbEnv },
    });
    dbSecret.grantRead(queryHandler);
    const queryAlias = queryHandler.addAlias('live', {
      provisionedConcurrentExecutions: 50,
    });

    // Projector Handler (Kinesis → loans projection on the writer)
    const projectorHandler = new nodejs.NodejsFunction(this, 'ProjectorHandler', {
      ...commonProps,
      entry: path.join(__dirname, '../../src/projector/handler.ts'),
      handler: 'handler',
      functionName: `loan-projector-${suffix}`,
      timeout: cdk.Duration.seconds(30),
      environment: { ...dbEnv },
    });
    dbSecret.grantRead(projectorHandler);
    projectorHandler.addEventSource(
      new eventsources.KinesisEventSource(stream, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 25,
        bisectBatchOnError: true,
        retryAttempts: 5,
      })
    );

    // Health Handler (SELECT 1 on reader)
    const healthHandler = new nodejs.NodejsFunction(this, 'HealthHandler', {
      ...commonProps,
      entry: path.join(__dirname, '../../src/health/handler.ts'),
      handler: 'handler',
      functionName: `loan-health-${suffix}`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: { ...dbEnv },
    });
    dbSecret.grantRead(healthHandler);

    // API/projector Lambdas must not run before the schema exists.
    for (const fn of [commandHandler, queryHandler, projectorHandler, healthHandler]) {
      fn.node.addDependency(migration);
    }

    // ========== API GATEWAY (IAM auth) + WAF ==========
    const api = new apigateway.RestApi(this, 'LoanApi', {
      restApiName: `Loan API (${suffix})`,
      description: `CQRS/ES Loan API - Aurora PostgreSQL - ${suffix}`,
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
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
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
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
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
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });

    // API Routes (aliases for provisioned concurrency)
    const commandIntegration = new apigateway.LambdaIntegration(commandAlias);
    const queryIntegration = new apigateway.LambdaIntegration(queryAlias);
    const healthIntegration = new apigateway.LambdaIntegration(healthHandler);

    const apiResource = api.root.addResource('api');
    const loansResource = apiResource.addResource('loans');
    loansResource.addMethod('POST', commandIntegration);
    loansResource.addMethod('GET', queryIntegration);

    const loanByIdResource = loansResource.addResource('{id}');
    loanByIdResource.addMethod('GET', queryIntegration);
    loanByIdResource.addResource('approve').addMethod('POST', commandIntegration);
    loanByIdResource.addResource('reject').addMethod('POST', commandIntegration);
    loanByIdResource.addResource('disburse').addMethod('POST', commandIntegration);

    const statusResource = loansResource.addResource('status');
    statusResource.addResource('{status}').addMethod('GET', queryIntegration);

    loansResource.addResource('health').addMethod('GET', healthIntegration);

    // ========== OUTPUTS ==========
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL (IAM/SigV4 auth required)',
    });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'DbWriterEndpoint', {
      value: cluster.clusterEndpoint.hostname,
      description: 'Aurora writer (cluster) endpoint — event store + projection writes',
    });
    new cdk.CfnOutput(this, 'DbReaderEndpoint', {
      value: cluster.clusterReadEndpoint.hostname,
      description: 'Aurora reader endpoint — query side',
    });
    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: dbSecret.secretArn,
      description: 'Secrets Manager ARN of the generated cluster credentials',
    });
    new cdk.CfnOutput(this, 'EventStreamName', { value: stream.streamName });
  }
}
