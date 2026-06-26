import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly lambdaSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with 2 AZs (sufficient for PoC)
    const vpc = new ec2.Vpc(this, 'LoanVpc', {
      maxAzs: 2,
      natGateways: 1, // Single NAT for cost savings
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // Security group for Lambda functions (allows outbound to Redis)
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'Security group for Lambda functions',
      allowAllOutbound: true,
    });

    this.vpc = vpc;
    this.privateSubnets = vpc.privateSubnets;
    this.lambdaSecurityGroup = lambdaSg;

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
  }
}
