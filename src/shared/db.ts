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
 */
import { Pool, PoolClient } from 'pg';
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
