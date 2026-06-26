/**
 * Projector Lambda — Builds the read model from DynamoDB Streams.
 *
 * This is the bridge between the Event Store (write side) and Redis (read side).
 * It receives DynamoDB Stream events whenever a new event is written to the
 * event store, then updates the Redis read model accordingly.
 *
 * Key insight: This projection can be rebuilt at any time by replaying
 * all events from DynamoDB. The read model is disposable — events are the truth.
 */

import { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { AttributeValue } from '@aws-sdk/client-dynamodb';
import Redis from 'ioredis';
import { DomainEvent, EventTypes } from '../domain/events';

let redis: Redis;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      host: process.env.REDIS_HOST!,
      port: parseInt(process.env.REDIS_PORT || '6379'),
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
      connectTimeout: 5000,
      maxRetriesPerRequest: 3,
    });
  }
  return redis;
}

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  const client = getRedis();

  for (const record of event.Records) {
    if (record.eventName !== 'INSERT') continue;
    await processRecord(client, record);
  }
}

async function processRecord(client: Redis, record: DynamoDBRecord): Promise<void> {
  if (!record.dynamodb?.NewImage) return;

  const item = unmarshall(
    record.dynamodb.NewImage as Record<string, AttributeValue>
  ) as DomainEvent;

  const { aggregateId, eventType, timestamp, payload } = item;

  console.log(`Processing event: ${eventType} for aggregate: ${aggregateId}`);

  switch (eventType) {
    case EventTypes.LOAN_APPLICATION_SUBMITTED:
      await handleSubmitted(client, aggregateId, timestamp, payload);
      break;
    case EventTypes.LOAN_APPROVED:
      await handleApproved(client, aggregateId, timestamp, payload);
      break;
    case EventTypes.LOAN_REJECTED:
      await handleRejected(client, aggregateId, payload);
      break;
    case EventTypes.LOAN_DISBURSED:
      await handleDisbursed(client, aggregateId, timestamp, payload);
      break;
    default:
      console.warn(`Unknown event type: ${eventType}`);
  }
}

async function handleSubmitted(
  client: Redis,
  loanId: string,
  timestamp: string,
  payload: Record<string, unknown>
): Promise<void> {
  const loanView = {
    loanId,
    applicantName: payload.applicantName,
    requestedAmount: payload.requestedAmount,
    purpose: payload.purpose,
    status: 'SUBMITTED',
    submittedAt: timestamp,
    approvedAmount: null,
    approvedBy: null,
    approvedAt: null,
    rejectedReason: null,
    rejectedBy: null,
    disbursedAt: null,
  };

  const pipeline = client.pipeline();
  pipeline.set(`loan:${loanId}`, JSON.stringify(loanView));
  pipeline.zadd('loans:all', Date.parse(timestamp).toString(), loanId);
  pipeline.sadd('loans:status:SUBMITTED', loanId);
  await pipeline.exec();
}

async function handleApproved(
  client: Redis,
  loanId: string,
  timestamp: string,
  payload: Record<string, unknown>
): Promise<void> {
  const existing = await client.get(`loan:${loanId}`);
  if (!existing) return;

  const loan = JSON.parse(existing);
  loan.status = 'APPROVED';
  loan.approvedAmount = payload.approvedAmount;
  loan.approvedBy = payload.approvedBy;
  loan.approvedAt = timestamp;

  const pipeline = client.pipeline();
  pipeline.set(`loan:${loanId}`, JSON.stringify(loan));
  pipeline.srem('loans:status:SUBMITTED', loanId);
  pipeline.sadd('loans:status:APPROVED', loanId);
  await pipeline.exec();
}

async function handleRejected(
  client: Redis,
  loanId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const existing = await client.get(`loan:${loanId}`);
  if (!existing) return;

  const loan = JSON.parse(existing);
  loan.status = 'REJECTED';
  loan.rejectedReason = payload.reason;
  loan.rejectedBy = payload.rejectedBy;

  const pipeline = client.pipeline();
  pipeline.set(`loan:${loanId}`, JSON.stringify(loan));
  pipeline.srem('loans:status:SUBMITTED', loanId);
  pipeline.sadd('loans:status:REJECTED', loanId);
  await pipeline.exec();
}

async function handleDisbursed(
  client: Redis,
  loanId: string,
  timestamp: string,
  payload: Record<string, unknown>
): Promise<void> {
  const existing = await client.get(`loan:${loanId}`);
  if (!existing) return;

  const loan = JSON.parse(existing);
  loan.status = 'DISBURSED';
  loan.disbursedAt = timestamp;
  loan.disbursementAccount = payload.disbursementAccount;

  const pipeline = client.pipeline();
  pipeline.set(`loan:${loanId}`, JSON.stringify(loan));
  pipeline.srem('loans:status:APPROVED', loanId);
  pipeline.sadd('loans:status:DISBURSED', loanId);
  await pipeline.exec();
}
