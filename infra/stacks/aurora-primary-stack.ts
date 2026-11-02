import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as crypto from 'crypto';
import { SCHEMA_STATEMENTS } from '../../src/migration/schema';
import {
  AURORA_ENGINE_VERSION,
  DB_NAME,
  DB_SECRET_NAME,
  DB_USERNAME,
  GLOBAL_CLUSTER_ID,
  KINESIS_STREAM_NAME,
  SERVERLESS_V2_MAX_ACU,
  SERVERLESS_V2_MIN_ACU,
} from '../config';
import { LoanNetwork } from '../constructs/loan-network';
import { LoanFunctionFactory, LoanService, dbEnvironment } from '../constructs/loan-service';

export interface AuroraPrimaryStackProps extends cdk.StackProps {
  /** Physical-name suffix for Lambdas, e.g. 'aurora-primary'. */
  readonly nameSuffix: string;
  /** Region the generated secret is replicated to (the Global Database secondary). */
  readonly secondaryRegion: string;
}

/**
 * Primary region of the Aurora Global Database (us-east-1).
 *
 * - Aurora PostgreSQL Serverless v2 cluster (writer + reader): the ONLY writer
 *   of the global database. Event store (`events`) + projection (`loans`).
 * - AWS::RDS::GlobalCluster `loan-aurora-global` built from this cluster.
 * - Credentials secret replicated to the secondary region.
 * - Kinesis stream (single, in this region) + projector + schema migration.
 * - Full regional API (command / query / health) behind IAM auth + WAF.
 */
export class AuroraPrimaryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuroraPrimaryStackProps) {
    super(scope, id, props);
    const suffix = props.nameSuffix;

    const network = new LoanNetwork(this, 'Network');

    // ========== DATA: Aurora PostgreSQL Serverless v2 (global primary) ==========
    // Customer-managed key; RETAIN so the final SNAPSHOT stays restorable after destroy.
    const storageKey = new kms.Key(this, 'DbStorageKey', {
      description: 'Aurora storage encryption - loan-aurora-global primary',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const cluster = new rds.DatabaseCluster(this, 'LoanDb', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: AURORA_ENGINE_VERSION }),
      writer: rds.ClusterInstance.serverlessV2('writer'),
      readers: [rds.ClusterInstance.serverlessV2('reader', { scaleWithWriter: true })],
      serverlessV2MinCapacity: SERVERLESS_V2_MIN_ACU,
      serverlessV2MaxCapacity: SERVERLESS_V2_MAX_ACU,
      credentials: rds.Credentials.fromGeneratedSecret(DB_USERNAME, {
        secretName: DB_SECRET_NAME,
        replicaRegions: [{ region: props.secondaryRegion }],
      }),
      defaultDatabaseName: DB_NAME,
      storageEncrypted: true,
      storageEncryptionKey: storageKey,
      vpc: network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.dbSg],
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });
    const dbSecret = cluster.secret!;

    // Global Database built from the existing primary cluster. Engine, version
    // and encryption are inherited from the source cluster, so they are not set.
    const globalCluster = new rds.CfnGlobalCluster(this, 'GlobalCluster', {
      globalClusterIdentifier: GLOBAL_CLUSTER_ID,
      sourceDbClusterIdentifier: cluster.clusterArn,
      deletionProtection: false,
    });
    // Wait for the whole cluster construct (incl. writer/reader instances).
    globalCluster.node.addDependency(cluster);

    // Kinesis — event distribution (both regions' command Lambdas publish here)
    const stream = new kinesis.Stream(this, 'EventStream', {
      streamName: KINESIS_STREAM_NAME,
      shardCount: 2,
      retentionPeriod: cdk.Duration.hours(168), // 7 days
    });

    // ========== COMPUTE ==========
    const functions = new LoanFunctionFactory(this, {
      vpc: network.vpc,
      securityGroup: network.lambdaSg,
      dbSecret,
      dbEnv: dbEnvironment({
        writerHost: cluster.clusterEndpoint.hostname,
        readerHost: cluster.clusterReadEndpoint.hostname,
        secretArn: dbSecret.secretArn,
      }),
    });

    // Schema migration (custom resource → Provider → migration Lambda).
    // Primary only: DDL replicates to the secondary through the global database.
    const migrationHandler = functions.create('MigrationHandler', {
      entry: 'migration/handler.ts',
      functionName: `loan-migration-${suffix}`,
      timeout: cdk.Duration.minutes(2),
    });
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

    const service = new LoanService(this, 'Service', {
      nameSuffix: suffix,
      functions,
      commandEnvironment: { KINESIS_STREAM_NAME: stream.streamName },
      dependsOn: [migration],
    });
    stream.grantWrite(service.commandHandler);

    // Projector (primary only): Kinesis notification → rebuild the loan from
    // the `events` table on the single writer (order-insensitive).
    const projectorHandler = functions.create('ProjectorHandler', {
      entry: 'projector/handler.ts',
      functionName: `loan-projector-${suffix}`,
      timeout: cdk.Duration.seconds(30),
    });
    projectorHandler.node.addDependency(migration);
    projectorHandler.addEventSource(
      new eventsources.KinesisEventSource(stream, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 25,
        bisectBatchOnError: true,
        retryAttempts: 5,
      })
    );

    // ========== OUTPUTS ==========
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: service.api.url,
      description: 'API Gateway URL (IAM/SigV4 auth required)',
    });
    new cdk.CfnOutput(this, 'VpcId', { value: network.vpc.vpcId });
    new cdk.CfnOutput(this, 'DbWriterEndpoint', {
      value: cluster.clusterEndpoint.hostname,
      description: 'Aurora global primary writer (cluster) endpoint',
    });
    new cdk.CfnOutput(this, 'DbReaderEndpoint', {
      value: cluster.clusterReadEndpoint.hostname,
      description: 'Aurora reader endpoint (us-east-1 query side)',
    });
    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: dbSecret.secretArn,
      description: 'Secrets Manager ARN of the generated cluster credentials',
    });
    new cdk.CfnOutput(this, 'GlobalClusterId', { value: globalCluster.ref });
    new cdk.CfnOutput(this, 'EventStreamName', { value: stream.streamName });
  }
}
