import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import {
  AURORA_ENGINE_VERSION,
  DB_SECRET_NAME,
  GLOBAL_CLUSTER_ID,
  KINESIS_STREAM_NAME,
  SERVERLESS_V2_MAX_ACU,
  SERVERLESS_V2_MIN_ACU,
} from '../config';
import { LoanNetwork } from '../constructs/loan-network';
import { LoanFunctionFactory, LoanService, dbEnvironment } from '../constructs/loan-service';

export interface AuroraSecondaryStackProps extends cdk.StackProps {
  /** Physical-name suffix for Lambdas, e.g. 'aurora-secondary'. */
  readonly nameSuffix: string;
  /** Region of the global primary (hosts the Kinesis stream + projector). */
  readonly primaryRegion: string;
}

/**
 * Secondary region of the Aurora Global Database (us-west-2).
 *
 * - Read-only Serverless v2 cluster joined to `loan-aurora-global` with
 *   global write forwarding: writes sent to this cluster's endpoint are
 *   forwarded to the primary writer in us-east-1.
 * - Two db.serverless replica instances: the region-local query side.
 * - Full regional API (command / query / health). No projector and no
 *   migration: schema and `loans` rows replicate from the primary.
 *
 * Must be deployed after the primary stack (global cluster + replicated secret).
 */
export class AuroraSecondaryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuroraSecondaryStackProps) {
    super(scope, id, props);
    const suffix = props.nameSuffix;

    const network = new LoanNetwork(this, 'Network');

    // ========== DATA: global secondary cluster ==========
    // A cross-region encrypted secondary needs a KMS key in ITS region.
    // DESTROY (7-day pending window): the secondary holds no unique data and
    // takes no final snapshot — the primary's SNAPSHOT + retained key cover recovery.
    const storageKey = new kms.Key(this, 'DbStorageKey', {
      description: 'Aurora storage encryption - loan-aurora-global secondary',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });

    const subnetGroup = new rds.SubnetGroup(this, 'DbSubnetGroup', {
      vpc: network.vpc,
      description: 'Aurora global secondary - isolated subnets',
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cluster = new rds.CfnDBCluster(this, 'LoanDbSecondary', {
      engine: 'aurora-postgresql',
      // Must match the primary exactly.
      engineVersion: AURORA_ENGINE_VERSION.auroraPostgresFullVersion,
      globalClusterIdentifier: GLOBAL_CLUSTER_ID,
      // No master username/password: credentials come from the primary.
      storageEncrypted: true,
      kmsKeyId: storageKey.keyArn,
      serverlessV2ScalingConfiguration: {
        minCapacity: SERVERLESS_V2_MIN_ACU,
        maxCapacity: SERVERLESS_V2_MAX_ACU,
      },
      vpcSecurityGroupIds: [network.dbSg.securityGroupId],
      dbSubnetGroupName: subnetGroup.subnetGroupName,
      enableGlobalWriteForwarding: true,
      enableCloudwatchLogsExports: ['postgresql'],
      copyTagsToSnapshot: true,
      deletionProtection: false,
      port: 5432,
    });
    // DeletionPolicy/UpdateReplacePolicy = Delete: a global secondary is a
    // replica of the primary's storage. Snapshotting it adds cost without
    // adding recoverability, and a Retained member would block deleting the
    // global cluster. Data protection lives on the primary (SNAPSHOT policy).
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Two serverless v2 replicas (both read-only; promotion tiers 0/1), spread over AZs.
    const instances = [0, 1].map((i) => {
      const inst = new rds.CfnDBInstance(this, `ReplicaInstance${i + 1}`, {
        dbClusterIdentifier: cluster.ref,
        dbInstanceClass: 'db.serverless',
        engine: 'aurora-postgresql',
        publiclyAccessible: false,
        promotionTier: i,
        availabilityZone: network.vpc.availabilityZones[i],
      });
      inst.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
      return inst;
    });

    // Replica of the primary's generated secret (same name, same random suffix).
    // fromSecretNameV2 has no full ARN, so grantRead targets
    // `arn:aws:secretsmanager:<this region>:<acct>:secret:loan-aurora/db-credentials-??????`,
    // which matches the replica's full ARN.
    const dbSecret = secretsmanager.Secret.fromSecretNameV2(this, 'DbSecret', DB_SECRET_NAME);

    // ========== COMPUTE ==========
    const functions = new LoanFunctionFactory(this, {
      vpc: network.vpc,
      securityGroup: network.lambdaSg,
      dbSecret,
      dbEnv: dbEnvironment({
        // Cluster endpoint of the secondary: accepts writes via global write forwarding.
        writerHost: cluster.attrEndpointAddress,
        readerHost: cluster.attrReadEndpointAddress,
        // Partial ARN in this region (no suffix) — accepted by GetSecretValue.
        secretArn: dbSecret.secretArn,
        writeForwarding: true,
      }),
    });

    const service = new LoanService(this, 'Service', {
      nameSuffix: suffix,
      functions,
      commandEnvironment: {
        KINESIS_STREAM_NAME,
        KINESIS_REGION: props.primaryRegion,
      },
      dependsOn: instances,
    });

    // Publish to the primary-region stream (same account). Exact ARN, no wildcard.
    const primaryStreamArn = this.formatArn({
      service: 'kinesis',
      region: props.primaryRegion,
      resource: 'stream',
      resourceName: KINESIS_STREAM_NAME,
    });
    service.commandHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kinesis:PutRecord', 'kinesis:PutRecords'],
        resources: [primaryStreamArn],
      })
    );

    // ========== OUTPUTS ==========
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: service.api.url,
      description: 'API Gateway URL (IAM/SigV4 auth required)',
    });
    new cdk.CfnOutput(this, 'VpcId', { value: network.vpc.vpcId });
    new cdk.CfnOutput(this, 'DbClusterEndpoint', {
      value: cluster.attrEndpointAddress,
      description: 'Secondary cluster endpoint (writes forwarded to the primary writer)',
    });
    new cdk.CfnOutput(this, 'DbReaderEndpoint', {
      value: cluster.attrReadEndpointAddress,
      description: 'Secondary reader endpoint (us-west-2 query side)',
    });
    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: dbSecret.secretArn,
      description: 'Partial ARN of the replicated credentials secret in this region',
    });
  }
}
