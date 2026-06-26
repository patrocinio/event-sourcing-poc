import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import * as path from 'path';

interface ComputeStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  privateSubnets: ec2.ISubnet[];
  lambdaSecurityGroup: ec2.ISecurityGroup;
  eventTable: dynamodb.ITable;
  kinesisStream: kinesis.IStream;
  redisEndpoint: string;
  redisPort: string;
}

export class ComputeStack extends cdk.Stack {
  public readonly commandHandler: lambda.IFunction;
  public readonly queryHandler: lambda.IFunction;
  public readonly healthHandler: lambda.IFunction;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const commonLambdaProps: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
      },
      tracing: lambda.Tracing.ACTIVE,
    };

    // Command Handler — processes write commands
    const commandHandler = new nodejs.NodejsFunction(this, 'CommandHandler', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/commands/handler.ts'),
      handler: 'handler',
      functionName: 'loan-command-handler',
      environment: {
        EVENT_TABLE_NAME: props.eventTable.tableName,
        KINESIS_STREAM_NAME: props.kinesisStream.streamName,
      },
      // Command handler does NOT need VPC (DynamoDB + Kinesis via public endpoints)
    });

    // Grant DynamoDB read/write and Kinesis write
    props.eventTable.grantReadWriteData(commandHandler);
    props.kinesisStream.grantWrite(commandHandler);

    // Query Handler — reads from Redis (needs VPC)
    const queryHandler = new nodejs.NodejsFunction(this, 'QueryHandler', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/queries/handler.ts'),
      handler: 'handler',
      functionName: 'loan-query-handler',
      timeout: cdk.Duration.seconds(5),
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateSubnets },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        REDIS_HOST: props.redisEndpoint,
        REDIS_PORT: props.redisPort,
      },
    });

    // Projector Handler — DynamoDB Streams → Redis (needs VPC)
    const projectorHandler = new nodejs.NodejsFunction(this, 'ProjectorHandler', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/projector/handler.ts'),
      handler: 'handler',
      functionName: 'loan-projector-handler',
      timeout: cdk.Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateSubnets },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        REDIS_HOST: props.redisEndpoint,
        REDIS_PORT: props.redisPort,
      },
    });

    // Trigger projector from DynamoDB Streams
    projectorHandler.addEventSource(
      new eventsources.DynamoEventSource(props.eventTable as dynamodb.Table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        retryAttempts: 3,
      })
    );

    // Health Handler (needs VPC for Redis ping)
    const healthHandler = new nodejs.NodejsFunction(this, 'HealthHandler', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../../src/health/handler.ts'),
      handler: 'handler',
      functionName: 'loan-health-handler',
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateSubnets },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        REDIS_HOST: props.redisEndpoint,
        REDIS_PORT: props.redisPort,
      },
    });

    this.commandHandler = commandHandler;
    this.queryHandler = queryHandler;
    this.healthHandler = healthHandler;
  }
}
