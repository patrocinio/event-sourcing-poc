/**
 * Health Check Lambda — verifies Redis connectivity.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import Redis from 'ioredis';

export async function handler(
  _event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  let redisStatus = 'DOWN';

  try {
    const redis = new Redis({
      host: process.env.REDIS_HOST!,
      port: parseInt(process.env.REDIS_PORT || '6379'),
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
    });

    const pong = await redis.ping();
    redisStatus = pong === 'PONG' ? 'UP' : 'DOWN';
    await redis.quit();
  } catch {
    redisStatus = 'DOWN';
  }

  const status = redisStatus === 'UP' ? 'UP' : 'DOWN';

  return {
    statusCode: status === 'UP' ? 200 : 503,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status,
      components: {
        redis: { status: redisStatus },
      },
    }),
  };
}
