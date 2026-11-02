/**
 * Shared Aurora PostgreSQL access for Lambda handlers.
 *
 * - Credentials come from the cluster's Secrets Manager secret (fetched once
 *   per cold start and cached for the lifetime of the execution environment).
 * - One module-scoped pg.Pool per endpoint role:
 *     'writer' -> DB_WRITER_HOST (cluster endpoint: event store + projection writes)
 *     'reader' -> DB_READER_HOST (reader endpoint: query side)
 * - TLS is always on with certificate verification. The RDS CA bundle is
 *   provided to Node via NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem.
 * - Aurora Global Database secondary (DB_WRITE_FORWARDING=true): the writer
 *   host is the secondary cluster endpoint, which forwards writes to the
 *   primary writer. Every new writer connection runs
 *   `SET apg_write_forward.consistency_mode = 'SESSION'` before it is handed
 *   out, so a session always reads its own forwarded writes.
 */
import { ClientBase, Pool, PoolClient } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

export type DbRole = 'writer' | 'reader';

interface DbSecret {
  username: string;
  password: string;
  port?: number;
}

const secrets = new SecretsManagerClient({});
let secretPromise: Promise<DbSecret> | undefined;
const pools: Partial<Record<DbRole, Pool>> = {};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function loadSecret(): Promise<DbSecret> {
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: requireEnv('DB_SECRET_ARN') })
  );
  if (!res.SecretString) throw new Error('Database secret has no SecretString');
  const parsed = JSON.parse(res.SecretString) as DbSecret;
  if (!parsed.username || !parsed.password) {
    throw new Error('Database secret is missing username/password');
  }
  return parsed;
}

function getSecret(): Promise<DbSecret> {
  if (!secretPromise) {
    // Reset on failure so the next invocation can retry instead of caching a rejection.
    secretPromise = loadSecret().catch((err) => {
      secretPromise = undefined;
      throw err;
    });
  }
  return secretPromise;
}

/** Returns the module-scoped pool for the given endpoint role, creating it on first use. */
export async function getPool(role: DbRole): Promise<Pool> {
  const existing = pools[role];
  if (existing) return existing;

  const secret = await getSecret();
  const host = requireEnv(role === 'writer' ? 'DB_WRITER_HOST' : 'DB_READER_HOST');

  // Re-check after the await in case a concurrent caller created it.
  if (pools[role]) return pools[role]!;

  const writeForwarding = role === 'writer' && isWriteForwardingEnabled();

  const pool = new Pool({
    host,
    port: Number(process.env.DB_PORT || secret.port || 5432),
    database: requireEnv('DB_NAME'),
    user: secret.username,
    password: secret.password,
    // Verify the server certificate against the RDS CA (NODE_EXTRA_CA_CERTS).
    ssl: { rejectUnauthorized: true },
    max: Number(process.env.DB_POOL_MAX || 3),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    // pg-pool awaits onConnect before handing out a NEW client (pool.connect
    // and pool.query alike). If it rejects, the client is closed and the error
    // is returned to the caller, so no connection is ever used without the
    // session consistency mode.
    ...(writeForwarding ? { onConnect: setWriteForwardConsistency } : {}),
  });
  // An idle client error must not crash the Lambda process; drop the pool so
  // the next invocation rebuilds it.
  pool.on('error', (err) => {
    console.error(`pg pool (${role}) error:`, err);
    if (pools[role] === pool) delete pools[role];
  });
  pools[role] = pool;
  return pool;
}

/** True when this region's writer endpoint is an Aurora global secondary with write forwarding. */
export function isWriteForwardingEnabled(): boolean {
  return process.env.DB_WRITE_FORWARDING === 'true';
}

/** Session-level read-after-write consistency for forwarded writes. */
export const WRITE_FORWARD_CONSISTENCY_SQL =
  "SET apg_write_forward.consistency_mode = 'SESSION'";

async function setWriteForwardConsistency(client: ClientBase): Promise<void> {
  try {
    await client.query(WRITE_FORWARD_CONSISTENCY_SQL);
  } catch (err) {
    console.error('Failed to set apg_write_forward.consistency_mode on new connection:', err);
    throw err; // pg-pool ends this client and fails the acquire
  }
}

/** Runs fn inside a transaction on the given endpoint. */
export async function withTransaction<T>(
  role: DbRole,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = await getPool(role);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** True when err is a PostgreSQL unique_violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505'
  );
}
