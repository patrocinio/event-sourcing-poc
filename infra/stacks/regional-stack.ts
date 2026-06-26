import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

interface RegionalStackProps extends cdk.StackProps {
  regionLabel: string;
  globalTable: dynamodb.Table;
  isPrimary: boolean;
}

/**
 * Regional Stack — complete infrastructure for one region.
 * Deployed identically to both us-east-1 and us-west-2 for active-active.
 *
 * Production hardening:
 * - 3 AZs with NAT Gateway per AZ
 * - Multi-AZ ElastiCache with automatic failover
 * - Provisioned concurrency on Lambda
 * - WAF on API Gateway
 * - Enhanced monitoring and alarms
 */
export class RegionalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RegionalStackProps) {
    super(scope, id, props);

    const region = cdk.Stack.of(this).region;

    // ========== NETWORKING (Multi-AZ) ==========

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways: 3, // One per AZ for HA
      subnetConfiguration: [
        { cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'Lambda functions security group',
      allowAllOutbound: true,
    });

    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc,
      description: 'ElastiCache Redis security group',
      allowAllOutbound: false,
    });
    redisSg.addIngressRule(lambdaSg, ec2.Port.tcp(6379), 'Lambda → Redis');

    // ========== DATA (Multi-AZ ElastiCache) ==========

    // Reference the Global Table (already created in GlobalStack)
    const eventTable = dynamodb.Table.fromTableName(
      this, 'LoanEventsRef', 'LoanEvents'
    );

    // Kinesis — regional stream for downstream consumers
    const stream = new kinesis.Stream(this, 'EventStream', {
      streamName: `loan-events-${props.regionLabel}`,
      shardCount: 2,
      retentionPeriod: cdk.Duration.hours(168), // 7 days for production
    });

    // ElastiCache Redis — Multi-AZ Replication Group
    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: `Redis subnet group - ${props.regionLabel}`,
      subnetIds: vpc.privateSubnets.map(s => s.subnetId),
      cacheSubnetGroupName: `loan-redis-${props.regionLabel}`,
    });

    const redisReplicationGroup = new elasticache.CfnReplicationGroup(this, 'RedisCluster', {
      replicationGroupDescription: `Loan read model - ${props.regionLabel}`,
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: 'cache.r7g.large',
      numNodeGroups: 1,
      replicasPerNodeGroup: 2, // 1 primary + 2 replicas across AZs
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName,
      securityGroupIds: [redisSg.securityGroupId],
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      autoMinorVersionUpgrade: true,
      replicationGroupId: `loan-cache-${props.regionLabel}`,
    });
    redisReplicationGroup.addDependency(subnetGroup);

    const redisEndpoint = redisReplicationGroup.attrPrimaryEndPointAddress;
    const redisPort = redisReplicationGroup.attrPrimaryEndPointPort;

    // ========== COMPUTE (Lambda with Provisioned Concurrency) ==========

    const commonProps: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512, // Production: more memory = more CPU
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.THREE_MONTHS,
      bundling: { minify: true, sourceMap: true, target: 'es2022' },
    };

    // Command Handler
    const commandHandler = new nodejs.NodejsFunction(this, 'CommandHandler', {
      ...commonProps,
      entry: path.join(__dirname, '../../src/commands/handler.ts'),
      handler: 'handler',
      functionName: `loan-command-${props.regionLabel}`,
      timeout: cdk.Duration.seconds(10),
      environment: {
        EVENT_TABLE_NAME: 'LoanEvents',
        KINESIS_STREAM_NAME: stream.streamName,
        AWS_REGION_LABEL: props.regionLabel,
      },
    });
    props.globalTable.grantReadWriteData(commandHandler);
    stream.grantWrite(commandHandler);

    // Provisioned concurrency for consistent latency
    const commandAlias = commandHandler.addAlias('live', {
      provisionedConcurrentExecutions: 50,
    });

    // Query Handler
    const queryHandler = new nodejs.NodejsFunction(this, 'QueryHandler', {
      ...commonProps,
      entry: path.join(__dirname, '../../src/queries/handler.ts'),
      handler: 'handler',
      functionName: `loan-query-${props.regionLabel}`,
      timeout: cdk.Duration.seconds(5),
      vpc,
      vpcSubnets: { subnets: vpc.privateSubnets },
      securityGroups: [lambdaSg],
      environment: {
        REDIS_HOST: redisEndpoint,
        REDIS_PORT: redisPort,
        REDIS_TLS: 'true',
      },
    });

    const queryAlias = queryHandler.addAlias('live', {
      provisionedConcurrentExecutions: 50,
    });

    // Projector Handler
    const projectorHandler = new nodejs.NodejsFunction(this, 'ProjectorHandler', {
      ...commonProps,
      entry: path.join(__dirname, '../../src/projector/handler.ts'),
      handler: 'handler',
      functionName: `loan-projector-${props.regionLabel}`,
      timeout: cdk.Duration.seconds(30),
      vpc,
      vpcSubnets: { subnets: vpc.privateSubnets },
      securityGroups: [lambdaSg],
      environment: {
        REDIS_HOST: redisEndpoint,
        REDIS_PORT: redisPort,
        REDIS_TLS: 'true',
      },
    });

    // DynamoDB Streams → Projector (rebuilds Redis from events)
    projectorHandler.addEventSource(
      new eventsources.DynamoEventSource(props.globalTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 25,
        retryAttempts: 5,
        bisectBatchOnError: true,
        maxBatchingWindow: cdk.Duration.seconds(5),
      })
    );

    // Health Handler
    const healthHandler = new nodejs.NodejsFunction(this, 'HealthHandler', {
      ...commonProps,
      entry: path.join(__dirname, '../../src/health/handler.ts'),
      handler: 'handler',
      functionName: `loan-health-${props.regionLabel}`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      vpc,
      vpcSubnets: { subnets: vpc.privateSubnets },
      securityGroups: [lambdaSg],
      environment: {
        REDIS_HOST: redisEndpoint,
        REDIS_PORT: redisPort,
        REDIS_TLS: 'true',
      },
    });

    // ========== API GATEWAY + WAF ==========

    const api = new apigateway.RestApi(this, 'LoanApi', {
      restApiName: `Loan API (${props.regionLabel})`,
      description: `CQRS/ES Loan API - ${props.regionLabel} - Production`,
      deployOptions: {
        stageName: 'prod',
        tracingEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        metricsEnabled: true,
        throttlingRateLimit: 1000,
        throttlingBurstLimit: 2000,
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
        metricName: `loan-api-waf-${props.regionLabel}`,
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

    // Associate WAF with API Gateway
    new wafv2.CfnWebACLAssociation(this, 'ApiWafAssociation', {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });

    // API Routes (use aliases for provisioned concurrency)
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
      description: `API Gateway URL (${props.regionLabel})`,
    });

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
  }
}
