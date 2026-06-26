/**
 * Command Handler Lambda — Write side of CQRS.
 *
 * Flow:
 * 1. Parse command from API Gateway request
 * 2. Load events from DynamoDB (event store)
 * 3. Replay events to get current aggregate state
 * 4. Validate command against state (business rules)
 * 5. If valid: persist new event (optimistic concurrency)
 * 6. Publish event to Kinesis for downstream consumers
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { v4 as uuidv4 } from 'uuid';
import { DomainEvent, EventTypes, createEvent } from '../domain/events';
import { rehydrate, validateCommand } from '../domain/aggregate';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const kinesis = new KinesisClient({});

const TABLE_NAME = process.env.EVENT_TABLE_NAME!;
const STREAM_NAME = process.env.KINESIS_STREAM_NAME!;

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const method = event.httpMethod;
    const path = event.path;
    const pathParts = path.split('/').filter(Boolean); // ['api', 'loans', ...]

    if (method !== 'POST') {
      return response(405, { error: 'Method not allowed' });
    }

    const body = event.body ? JSON.parse(event.body) : {};

    // POST /api/loans — Submit new loan
    if (pathParts.length === 2 && pathParts[1] === 'loans') {
      return handleSubmitLoan(body);
    }

    // POST /api/loans/{id}/approve
    // POST /api/loans/{id}/reject
    // POST /api/loans/{id}/disburse
    if (pathParts.length === 4 && pathParts[1] === 'loans') {
      const loanId = pathParts[2];
      const action = pathParts[3];
      return handleLoanAction(loanId, action, body);
    }

    return response(404, { error: 'Not found' });
  } catch (err) {
    console.error('Command handler error:', err);
    return response(500, { error: 'Internal server error' });
  }
}

async function handleSubmitLoan(
  body: Record<string, unknown>
): Promise<APIGatewayProxyResult> {
  const { applicantName, requestedAmount, purpose } = body as {
    applicantName?: string;
    requestedAmount?: number;
    purpose?: string;
  };

  if (!applicantName) return response(400, { error: 'applicantName is required' });
  if (!requestedAmount || requestedAmount <= 0)
    return response(400, { error: 'requestedAmount must be positive' });
  if (!purpose) return response(400, { error: 'purpose is required' });

  const loanId = uuidv4();
  const domainEvent = createEvent(loanId, 1, EventTypes.LOAN_APPLICATION_SUBMITTED, {
    applicantName,
    requestedAmount,
    purpose,
  });

  await persistEvent(domainEvent);
  await publishToKinesis(domainEvent);

  return response(201, { loanId, status: 'SUBMITTED' });
}

async function handleLoanAction(
  loanId: string,
  action: string,
  body: Record<string, unknown>
): Promise<APIGatewayProxyResult> {
  // Load and replay events to get current state
  const events = await loadEvents(loanId);
  if (events.length === 0) {
    return response(404, { error: 'Loan not found' });
  }

  const state = rehydrate(events);

  // Map action to command name
  const commandMap: Record<string, string> = {
    approve: 'ApproveLoan',
    reject: 'RejectLoan',
    disburse: 'DisburseLoan',
  };

  const commandName = commandMap[action];
  if (!commandName) {
    return response(404, { error: `Unknown action: ${action}` });
  }

  // Validate business rules
  const validationError = validateCommand(state, commandName);
  if (validationError) {
    return response(409, { error: validationError });
  }

  // Build event based on action
  const nextVersion = state.version + 1;
  let domainEvent: DomainEvent;

  switch (action) {
    case 'approve': {
      const { approvedAmount, approvedBy } = body as {
        approvedAmount?: number;
        approvedBy?: string;
      };
      if (!approvedAmount || approvedAmount <= 0)
        return response(400, { error: 'approvedAmount must be positive' });
      if (!approvedBy) return response(400, { error: 'approvedBy is required' });
      domainEvent = createEvent(loanId, nextVersion, EventTypes.LOAN_APPROVED, {
        approvedAmount,
        approvedBy,
      });
      break;
    }
    case 'reject': {
      const { reason, rejectedBy } = body as {
        reason?: string;
        rejectedBy?: string;
      };
      if (!reason) return response(400, { error: 'reason is required' });
      if (!rejectedBy) return response(400, { error: 'rejectedBy is required' });
      domainEvent = createEvent(loanId, nextVersion, EventTypes.LOAN_REJECTED, {
        reason,
        rejectedBy,
      });
      break;
    }
    case 'disburse': {
      const { disbursementAccount } = body as { disbursementAccount?: string };
      if (!disbursementAccount)
        return response(400, { error: 'disbursementAccount is required' });
      domainEvent = createEvent(loanId, nextVersion, EventTypes.LOAN_DISBURSED, {
        disbursementAccount,
      });
      break;
    }
    default:
      return response(404, { error: `Unknown action: ${action}` });
  }

  // Persist with optimistic concurrency (condition: version doesn't exist yet)
  await persistEvent(domainEvent);
  await publishToKinesis(domainEvent);

  const statusMap: Record<string, string> = {
    approve: 'APPROVED',
    reject: 'REJECTED',
    disburse: 'DISBURSED',
  };

  return response(200, { loanId, status: statusMap[action] });
}

async function loadEvents(aggregateId: string): Promise<DomainEvent[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'aggregateId = :id',
      ExpressionAttributeValues: { ':id': aggregateId },
      ScanIndexForward: true, // oldest first
    })
  );

  return (result.Items || []) as DomainEvent[];
}

async function persistEvent(domainEvent: DomainEvent): Promise<void> {
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: domainEvent,
      ConditionExpression: 'attribute_not_exists(aggregateId) AND attribute_not_exists(version)',
    })
  );
}

async function publishToKinesis(domainEvent: DomainEvent): Promise<void> {
  await kinesis.send(
    new PutRecordCommand({
      StreamName: STREAM_NAME,
      PartitionKey: domainEvent.aggregateId,
      Data: Buffer.from(JSON.stringify(domainEvent)),
    })
  );
}

function response(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
