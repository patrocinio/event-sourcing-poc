/**
 * Query Handler Lambda — Read side of CQRS.
 *
 * Reads from the Redis projection (read model), NOT from the event store.
 * This demonstrates the key CQRS principle: reads and writes are separate.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import Redis from 'ioredis';

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

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const path = event.path;
    const pathParts = path.split('/').filter(Boolean);

    // GET /api/loans
    if (pathParts.length === 2 && pathParts[1] === 'loans') {
      return handleGetAllLoans();
    }

    // GET /api/loans/status/{status}
    if (pathParts.length === 4 && pathParts[2] === 'status') {
      const status = pathParts[3].toUpperCase();
      return handleGetLoansByStatus(status);
    }

    // GET /api/loans/{id}
    if (pathParts.length === 3 && pathParts[1] === 'loans') {
      const loanId = pathParts[2];
      return handleGetLoanById(loanId);
    }

    return response(404, { error: 'Not found' });
  } catch (err) {
    console.error('Query handler error:', err);
    return response(500, { error: 'Internal server error' });
  }
}

async function handleGetAllLoans(): Promise<APIGatewayProxyResult> {
  const client = getRedis();

  // Get latest 50 loan IDs from sorted set (newest first)
  const loanIds = await client.zrevrange('loans:all', 0, 49);

  if (loanIds.length === 0) {
    return response(200, []);
  }

  // Batch fetch all loan data
  const pipeline = client.pipeline();
  for (const id of loanIds) {
    pipeline.get(`loan:${id}`);
  }
  const results = await pipeline.exec();

  const loans = (results || [])
    .map(([err, data]) => (err ? null : data ? JSON.parse(data as string) : null))
    .filter(Boolean);

  return response(200, loans);
}

async function handleGetLoanById(loanId: string): Promise<APIGatewayProxyResult> {
  const client = getRedis();
  const data = await client.get(`loan:${loanId}`);

  if (!data) {
    return response(404, { error: 'Loan not found' });
  }

  return response(200, JSON.parse(data));
}

async function handleGetLoansByStatus(status: string): Promise<APIGatewayProxyResult> {
  const validStatuses = ['SUBMITTED', 'APPROVED', 'REJECTED', 'DISBURSED'];
  if (!validStatuses.includes(status)) {
    return response(400, { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  const client = getRedis();
  const loanIds = await client.smembers(`loans:status:${status}`);

  if (loanIds.length === 0) {
    return response(200, []);
  }

  const pipeline = client.pipeline();
  for (const id of loanIds) {
    pipeline.get(`loan:${id}`);
  }
  const results = await pipeline.exec();

  const loans = (results || [])
    .map(([err, data]) => (err ? null : data ? JSON.parse(data as string) : null))
    .filter(Boolean)
    .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());

  return response(200, loans);
}

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
