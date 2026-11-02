/**
 * Command Handler Lambda — Write side of CQRS.
 *
 * Flow:
 * 1. Parse command from API Gateway request
 * 2. Load events from Aurora PostgreSQL (event store, writer endpoint)
 * 3. Replay events to get current aggregate state
 * 4. Validate command against state (business rules)
 * 5. If valid: INSERT new event; the (aggregate_id, version) primary key gives
 *    optimistic concurrency — a racing writer gets 23505 -> HTTP 409
 * 6. After commit, publish event to Kinesis (drives the projector)
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { v4 as uuidv4 } from 'uuid';
import { DomainEvent, EventTypes, createEvent } from '../domain/events';
import { rehydrate, validateCommand } from '../domain/aggregate';
import { getPool, isUniqueViolation } from '../shared/db';

// The stream lives in the primary region only; the secondary region sets
// KINESIS_REGION so its command Lambda publishes cross-region.
const kinesis = new KinesisClient({ region: process.env.KINESIS_REGION || undefined });

/** Thrown when another writer already appended this (aggregate_id, version). */
class ConcurrencyError extends Error {}

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
      // `return await` so rejections (e.g. ConcurrencyError) reach the catch below.
      return await handleSubmitLoan(body);
    }

    // POST /api/loans/{id}/approve
    // POST /api/loans/{id}/reject
    // POST /api/loans/{id}/disburse
    if (pathParts.length === 4 && pathParts[1] === 'loans') {
      const loanId = pathParts[2];
      const action = pathParts[3];
      return await handleLoanAction(loanId, action, body);
    }

    return response(404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof ConcurrencyError) {
      return response(409, { error: 'Concurrent modification, retry' });
    }
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

  // Persist with optimistic concurrency (PK (aggregate_id, version) must not exist yet)
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
  // Read from the WRITER pool: command validation needs read-your-writes.
  // In the secondary region this is the write-forwarding cluster endpoint:
  // SESSION consistency covers this session's own writes, but another
  // region's latest event may not have replicated yet. That is safe — a stale
  // version makes the INSERT hit the (aggregate_id, version) PK -> 409, retry.
  const pool = await getPool('writer');
  const result = await pool.query(
    `SELECT aggregate_id, version, event_type, occurred_at, payload
       FROM events
      WHERE aggregate_id = $1
      ORDER BY version`,
    [aggregateId]
  );
  return result.rows.map((r) => ({
    aggregateId: r.aggregate_id as string,
    version: Number(r.version),
    eventType: r.event_type as string,
    timestamp: (r.occurred_at as Date).toISOString(),
    payload: r.payload as Record<string, unknown>,
  }));
}
async function persistEvent(domainEvent: DomainEvent): Promise<void> {
  const pool = await getPool('writer');
  try {
    // Single-statement autocommit: the event is durable when this resolves.
    await pool.query(
      `INSERT INTO events (aggregate_id, version, event_type, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        domainEvent.aggregateId,
        domainEvent.version,
        domainEvent.eventType,
        domainEvent.timestamp,
        JSON.stringify(domainEvent.payload),
      ]
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConcurrencyError();
    throw err;
  }
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
