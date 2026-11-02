import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Per-region network: 3-AZ VPC with public / private-with-egress / isolated
 * tiers, a Lambda security group, and a database security group whose ONLY
 * ingress is TCP 5432 from the Lambda security group.
 */
export class LoanNetwork extends Construct {
  readonly vpc: ec2.Vpc;
  readonly lambdaSg: ec2.SecurityGroup;
  readonly dbSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      // One NAT per region keeps cost (and Elastic IP use) down for this PoC.
      // Lambda egress (Kinesis, Secrets Manager) loses AZ redundancy; use 3 for HA.
      natGateways: 1,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        // Database tier: no route to the internet in either direction.
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    this.lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'Lambda functions security group',
      allowAllOutbound: true, // Kinesis / Secrets Manager via NAT, Aurora in-VPC
    });

    this.dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      description: 'Aurora PostgreSQL - ingress only from Lambda SG on 5432',
      allowAllOutbound: false,
    });
    this.dbSg.addIngressRule(this.lambdaSg, ec2.Port.tcp(5432), 'Lambda to Aurora PostgreSQL');
  }
}
