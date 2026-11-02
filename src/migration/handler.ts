/**
 * Schema migration Lambda — invoked by a CloudFormation custom resource
 * (custom-resources.Provider). Runs idempotent DDL on the writer endpoint.
 *
 * Create/Update: apply SCHEMA_STATEMENTS inside one transaction
 *                (PostgreSQL DDL is transactional).
 * Delete:        no-op — data is preserved; the cluster's SNAPSHOT removal
 *                policy governs what happens to it.
 */
import { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { withTransaction } from '../shared/db';
import { SCHEMA_STATEMENTS } from './schema';

const PHYSICAL_ID = 'loans-schema';

export async function handler(
  event: CloudFormationCustomResourceEvent
): Promise<{ PhysicalResourceId: string }> {
  console.log(`Migration request: ${event.RequestType}`);

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: PHYSICAL_ID };
  }

  await withTransaction('writer', async (client) => {
    // Serialize concurrent migrations (e.g. overlapping stack updates).
    await client.query('SELECT pg_advisory_xact_lock(727274)');
    for (const sql of SCHEMA_STATEMENTS) {
      await client.query(sql);
    }
  });

  console.log(`Applied ${SCHEMA_STATEMENTS.length} schema statements`);
  return { PhysicalResourceId: PHYSICAL_ID };
}
