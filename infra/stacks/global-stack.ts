import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

interface GlobalStackProps extends cdk.StackProps {
  primaryRegion: string;
  secondaryRegion: string;
  domainName: string;
}

/**
 * Global Stack — resources that span regions.
 * - DynamoDB Global Table (event store with bi-directional replication)
 *
 * Route53 configuration is separate to allow manual domain setup.
 */
export class GlobalStack extends cdk.Stack {
  public readonly globalTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: GlobalStackProps) {
    super(scope, id, props);

    // DynamoDB Global Table — Event Store
    // Active-active: both regions can read and write simultaneously.
    // Replication latency: typically <1 second between regions.
    this.globalTable = new dynamodb.Table(this, 'LoanEventsGlobal', {
      tableName: 'LoanEvents',
      partitionKey: { name: 'aggregateId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'version', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecovery: true,
      deletionProtection: true,
      replicationRegions: [props.secondaryRegion],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Outputs
    new cdk.CfnOutput(this, 'GlobalTableName', {
      value: this.globalTable.tableName,
      description: 'DynamoDB Global Table name (event store)',
    });

    new cdk.CfnOutput(this, 'ReplicationRegions', {
      value: `${props.primaryRegion}, ${props.secondaryRegion}`,
      description: 'Regions where the global table is replicated',
    });
  }
}
