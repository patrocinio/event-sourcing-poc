/**
 * Health Check Lambda — verifies connectivity to the Aurora reader endpoint
 * (the dependency the query side relies on).
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getPool } from '../shared/db';

export async function handler(
  _event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  let dbStatus = 'DOWN';
  try {
    const pool = await getPool('reader');
    const result = await pool.query('SELECT 1 AS ok');
    dbStatus = result.rows[0]?.ok === 1 ? 'UP' : 'DOWN';
  } catch (err) {
    console.error('Health check failed:', err);
    dbStatus = 'DOWN';
  }

  const status = dbStatus === 'UP' ? 'UP' : 'DOWN';
  return {
    statusCode: status === 'UP' ? 200 : 503,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status,
      components: {
        database: { status: dbStatus },
      },
    }),
  };
}
