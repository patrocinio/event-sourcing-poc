/**
 * Projector Lambda — builds the `loans` read model (primary region only).
 *
 * Command Lambdas in BOTH regions commit each event to the Aurora `events`
 * table (the secondary via global write forwarding) and then publish it to
 * the single Kinesis stream in the primary region. Because publishes come
 * from two regions, Kinesis can deliver a loan's events out of order (e.g. v3
 * from us-east-1 before v2 from us-west-2).
 *
 * The projector is therefore order-insensitive: a Kinesis record is only a
 * NOTIFICATION that aggregate X changed. For each notified aggregate, inside
 * one writer transaction it:
 *   1. locks the current `loans` row (SELECT ... FOR UPDATE),
 *   2. loads ALL events for the aggregate from `events` on the WRITER
 *      (the source of truth; every committed event is visible there),
 *   3. folds them with projectAll (sorted by version, deduplicated),
 *   4. upserts guarded by `WHERE loans.last_version < EXCLUDED.last_version`.
 *
 * Duplicates, replays and reordering are all no-ops or converge to the same
 * row. The projection is written once, on the global primary writer, and
 * reaches the us-west-2 replicas through Aurora Global Database replication.
 */
import { KinesisStreamEvent, KinesisStreamRecord } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { DomainEvent } from '../domain/events';
import { withTransaction } from '../shared/db';
import { LoanRow, fromDbRow, projectAll } from '../shared/loan-projection';

export async function handler(event: KinesisStreamEvent): Promise<void> {
  // Each notification triggers a full rebuild, so one rebuild per aggregate
  // per batch is enough. Order of first appearance is kept.
  const aggregateIds = new Set<string>();
  for (const record of event.Records) {
    const domainEvent = decode(record);
    if (domainEvent) aggregateIds.add(domainEvent.aggregateId);
  }
  for (const aggregateId of aggregateIds) {
    await rebuildProjection(aggregateId);
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

async function rebuildProjection(aggregateId: string): Promise<void> {
  await withTransaction('writer', async (client) => {
    const existing = await client.query(
      'SELECT * FROM loans WHERE loan_id = $1 FOR UPDATE',
      [aggregateId]
    );
    const current = existing.rows[0] ? fromDbRow(existing.rows[0]) : null;

    const events = await loadEvents(client, aggregateId);
    const next = projectAll(events);
    if (!next) {
      console.log(`No projectable history for ${aggregateId} (${events.length} events)`);
      return;
    }
    if (current && next.last_version <= current.last_version) {
      console.log(`Projection for ${aggregateId} already at v${current.last_version}`);
      return;
    }
    console.log(
      `Projecting ${aggregateId}: v${current?.last_version ?? 0} -> v${next.last_version} (${next.status})`
    );
    await upsert(client, next);
  });
}

async function loadEvents(client: PoolClient, aggregateId: string): Promise<DomainEvent[]> {
  const result = await client.query(
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
