/**
 * Query Handler Lambda — Read side of CQRS.
 *
 * Reads the `loans` projection through the Aurora READER endpoint only,
 * never the event store. Reads are eventually consistent: the projector
 * (Kinesis-driven) plus reader replica lag sit between a command and its view.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getPool } from '../shared/db';
import { fromDbRow, toLoanView } from '../shared/loan-projection';

const LIST_LIMIT = 50; // same as the Redis implementation (latest 50)
const STATUS_LIMIT = 1000; // Redis returned the whole status set; cap it here
const VALID_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED', 'DISBURSED'];

const COLUMNS = `loan_id, applicant_name, requested_amount, purpose, status,
  approved_amount, approved_by, approved_at, rejection_reason, rejected_by,
  disbursement_account, disbursed_at, created_at, updated_at, last_version`;

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const path = event.path;
    const pathParts = path.split('/').filter(Boolean);

    // GET /api/loans
    if (pathParts.length === 2 && pathParts[1] === 'loans') {
      return await handleGetAllLoans();
    }

    // GET /api/loans/status/{status}
    if (pathParts.length === 4 && pathParts[2] === 'status') {
      const status = pathParts[3].toUpperCase();
      return await handleGetLoansByStatus(status);
    }

    // GET /api/loans/{id}
    if (pathParts.length === 3 && pathParts[1] === 'loans') {
      const loanId = pathParts[2];
      return await handleGetLoanById(loanId);
    }

    return response(404, { error: 'Not found' });
  } catch (err) {
    console.error('Query handler error:', err);
    return response(500, { error: 'Internal server error' });
  }
}

async function handleGetAllLoans(): Promise<APIGatewayProxyResult> {
  const pool = await getPool('reader');
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM loans ORDER BY created_at DESC LIMIT $1`,
    [LIST_LIMIT]
  );
  return response(200, result.rows.map((r) => toLoanView(fromDbRow(r))));
}

async function handleGetLoanById(loanId: string): Promise<APIGatewayProxyResult> {
  const pool = await getPool('reader');
  const result = await pool.query(`SELECT ${COLUMNS} FROM loans WHERE loan_id = $1`, [loanId]);
  if (result.rows.length === 0) {
    return response(404, { error: 'Loan not found' });
  }
  return response(200, toLoanView(fromDbRow(result.rows[0])));
}

async function handleGetLoansByStatus(status: string): Promise<APIGatewayProxyResult> {
  if (!VALID_STATUSES.includes(status)) {
    return response(400, { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  const pool = await getPool('reader');
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM loans WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
    [status, STATUS_LIMIT]
  );
  return response(200, result.rows.map((r) => toLoanView(fromDbRow(r))));
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
