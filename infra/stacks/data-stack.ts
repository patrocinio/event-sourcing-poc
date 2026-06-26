import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface DataStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  privateSubnets: ec2.ISubnet[];
  lambdaSecurityGroup: ec2.ISecurityGroup;
}

export class DataStack extends cdk.Stack {
  public readonly eventTable: dynamodb.ITable;
  public readonly kinesisStream: kinesis.IStream;
  public readonly redisEndpoint: string;
  public readonly redisPort: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // DynamoDB Event Store
    const eventTable = new dynamodb.Table(this, 'LoanEvents', {
      tableName: 'LoanEvents',
      partitionKey: { name: 'aggregateId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'version', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });

    // Kinesis Data Stream for downstream event distribution
    const stream = new kinesis.Stream(this, 'LoanEventsStream', {
      streamName: 'loan-events-stream',
      shardCount: 1,
      retentionPeriod: cdk.Duration.hours(24),
    });

    // ElastiCache Redis — Read Model
    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc: props.vpc,
      description: 'Security group for ElastiCache Redis',
      allowAllOutbound: false,
    });

    // Allow Lambda SG to connect to Redis
    redisSg.addIngressRule(
      props.lambdaSecurityGroup,
      ec2.Port.tcp(6379),
      'Allow Lambda access to Redis'
    );

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for loan originations Redis',
      subnetIds: props.privateSubnets.map((s) => s.subnetId),
      cacheSubnetGroupName: 'loan-redis-subnet-group',
    });

    const redisCluster = new elasticache.CfnCacheCluster(this, 'RedisCluster', {
      engine: 'redis',
      cacheNodeType: 'cache.t3.micro',
      numCacheNodes: 1,
      clusterName: 'loan-read-model',
      cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
      engineVersion: '7.1',
    });

    redisCluster.addDependency(subnetGroup);

    this.eventTable = eventTable;
    this.kinesisStream = stream;
    this.redisEndpoint = redisCluster.attrRedisEndpointAddress;
    this.redisPort = redisCluster.attrRedisEndpointPort;

    // Outputs
    new cdk.CfnOutput(this, 'EventTableName', { value: eventTable.tableName });
    new cdk.CfnOutput(this, 'StreamName', { value: stream.streamName });
    new cdk.CfnOutput(this, 'RedisEndpoint', { value: this.redisEndpoint });
  }
}
