/**
 * Idempotent DDL for the Aurora PostgreSQL schema.
 *
 * - events: append-only event store; (aggregate_id, version) PK provides
 *   optimistic concurrency (a racing writer gets unique_violation 23505).
 * - loans:  read-model projection, written by the projector (writer endpoint)
 *   and queried through the reader endpoint.
 *
 * Statements only use IF NOT EXISTS so re-running is always safe.
 * approved_at / disbursed_at extend the base column list so the API can keep
 * returning approvedAt / disbursedAt exactly as the Redis read model did.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS events (
     aggregate_id text        NOT NULL,
     version      integer     NOT NULL,
     event_type   text        NOT NULL,
     occurred_at  timestamptz NOT NULL,
     payload      jsonb       NOT NULL,
     PRIMARY KEY (aggregate_id, version)
   )`,
  `CREATE INDEX IF NOT EXISTS events_occurred_at_idx ON events (occurred_at)`,
  `CREATE TABLE IF NOT EXISTS loans (
     loan_id              text PRIMARY KEY,
     applicant_name       text,
     requested_amount     numeric,
     purpose              text,
     status               text NOT NULL,
     approved_amount      numeric,
     approved_by          text,
     rejection_reason     text,
     rejected_by          text,
     disbursement_account text,
     created_at           timestamptz,
     updated_at           timestamptz,
     last_version         integer NOT NULL
   )`,
  `ALTER TABLE loans ADD COLUMN IF NOT EXISTS approved_at timestamptz`,
  `ALTER TABLE loans ADD COLUMN IF NOT EXISTS disbursed_at timestamptz`,
  `CREATE INDEX IF NOT EXISTS loans_status_idx ON loans (status)`,
  `CREATE INDEX IF NOT EXISTS loans_created_at_idx ON loans (created_at)`,
];
