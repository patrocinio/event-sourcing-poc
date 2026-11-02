/**
 * Projector Lambda — builds the `loans` read model from the Kinesis event stream.
 *
 * The command handler commits each event to the Aurora `events` table and then
 * publishes it to Kinesis (partition key = aggregateId, so per-loan order is
 * preserved within a shard). This Lambda consumes the stream and upserts the
 * projection on the WRITER endpoint; the query side reads it from the reader.
 *
 * Idempotency: Kinesis delivery is at-least-once. Each update is guarded by
 * `last_version`, both in the pure mapping (projectEvent) and in the SQL
 * upsert, so duplicates and stale replays are no-ops.
 *
 * The read model is disposable: it can be rebuilt at any time by replaying
 * the `events` table through projectEvent.
 */
import { KinesisStreamEvent, KinesisStreamRecord } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { DomainEvent } from '../domain/events';
import { withTransaction } from '../shared/db';
import { LoanRow, fromDbRow, projectEvent } from '../shared/loan-projection';

export async function handler(event: KinesisStreamEvent): Promise<void> {
  // Sequential on purpose: preserves per-aggregate ordering within the batch.
  for (const record of event.Records) {
    const domainEvent = decode(record);
    if (!domainEvent) continue;
    await applyToProjection(domainEvent);
  }
}

function decode(record: KinesisStreamRecord): DomainEvent | null {
  try {
    const json = Buffer.from(record.kinesis.data, 'base64').toString('utf8');
    const ev = JSON.parse(json) as DomainEvent;
    if (!ev.aggregateId || typeof ev.version !== 'number' || !ev.eventType) {
      throw new Error('missing aggregateId/version/eventType');
    }
    return ev;
  } catch (err) {
    // A malformed record can never succeed; skip it rather than block the shard.
    console.error(
      `Skipping malformed Kinesis record ${record.kinesis.sequenceNumber}:`,
      err
    );
    return null;
  }
}

async function applyToProjection(ev: DomainEvent): Promise<void> {
  console.log(`Processing event: ${ev.eventType} v${ev.version} for aggregate: ${ev.aggregateId}`);

  await withTransaction('writer', async (client) => {
    const existing = await client.query(
      'SELECT * FROM loans WHERE loan_id = $1 FOR UPDATE',
      [ev.aggregateId]
    );
    const current = existing.rows[0] ? fromDbRow(existing.rows[0]) : null;
    const next = projectEvent(current, ev);
    if (!next) {
      console.log(`No projection change for ${ev.aggregateId} v${ev.version}`);
      return;
    }
    await upsert(client, next);
  });
}

async function upsert(client: PoolClient, row: LoanRow): Promise<void> {
  await client.query(
    `INSERT INTO loans (
       loan_id, applicant_name, requested_amount, purpose, status,
       approved_amount, approved_by, approved_at, rejection_reason, rejected_by,
       disbursement_account, disbursed_at, created_at, updated_at, last_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (loan_id) DO UPDATE SET
       applicant_name       = EXCLUDED.applicant_name,
       requested_amount     = EXCLUDED.requested_amount,
       purpose              = EXCLUDED.purpose,
       status               = EXCLUDED.status,
       approved_amount      = EXCLUDED.approved_amount,
       approved_by          = EXCLUDED.approved_by,
       approved_at          = EXCLUDED.approved_at,
       rejection_reason     = EXCLUDED.rejection_reason,
       rejected_by          = EXCLUDED.rejected_by,
       disbursement_account = EXCLUDED.disbursement_account,
       disbursed_at         = EXCLUDED.disbursed_at,
       created_at           = EXCLUDED.created_at,
       updated_at           = EXCLUDED.updated_at,
       last_version         = EXCLUDED.last_version
     WHERE loans.last_version < EXCLUDED.last_version`,
    [
      row.loan_id,
      row.applicant_name,
      row.requested_amount,
      row.purpose,
      row.status,
      row.approved_amount,
      row.approved_by,
      row.approved_at,
      row.rejection_reason,
      row.rejected_by,
      row.disbursement_account,
      row.disbursed_at,
      row.created_at,
      row.updated_at,
      row.last_version,
    ]
  );
}
