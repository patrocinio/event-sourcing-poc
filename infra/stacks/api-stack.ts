import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  commandHandler: lambda.IFunction;
  queryHandler: lambda.IFunction;
  healthHandler: lambda.IFunction;
}

export class ApiStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const api = new apigateway.RestApi(this, 'LoanApi', {
      restApiName: 'Loan Originations API',
      description: 'CQRS/Event Sourcing Loan API — AWS Native',
      deployOptions: {
        stageName: 'prod',
        tracingEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // Command integration
    const commandIntegration = new apigateway.LambdaIntegration(
      props.commandHandler
    );

    // Query integration
    const queryIntegration = new apigateway.LambdaIntegration(
      props.queryHandler
    );

    // Health integration
    const healthIntegration = new apigateway.LambdaIntegration(
      props.healthHandler
    );

    // Routes: /api/loans
    const apiResource = api.root.addResource('api');
    const loansResource = apiResource.addResource('loans');

    // POST /api/loans (command)
    loansResource.addMethod('POST', commandIntegration);
    // GET /api/loans (query)
    loansResource.addMethod('GET', queryIntegration);

    // /api/loans/{id}
    const loanByIdResource = loansResource.addResource('{id}');
    // GET /api/loans/{id} (query)
    loanByIdResource.addMethod('GET', queryIntegration);

    // /api/loans/{id}/approve
    const approveResource = loanByIdResource.addResource('approve');
    approveResource.addMethod('POST', commandIntegration);

    // /api/loans/{id}/reject
    const rejectResource = loanByIdResource.addResource('reject');
    rejectResource.addMethod('POST', commandIntegration);

    // /api/loans/{id}/disburse
    const disburseResource = loanByIdResource.addResource('disburse');
    disburseResource.addMethod('POST', commandIntegration);

    // /api/loans/status/{status}
    const statusResource = loansResource.addResource('status');
    const statusByValueResource = statusResource.addResource('{status}');
    statusByValueResource.addMethod('GET', queryIntegration);

    // /api/loans/health
    const healthResource = loansResource.addResource('health');
    healthResource.addMethod('GET', healthIntegration);

    this.apiUrl = api.url;

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway endpoint URL',
    });
  }
}
