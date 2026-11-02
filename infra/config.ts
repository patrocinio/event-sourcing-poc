import * as rds from 'aws-cdk-lib/aws-rds';

/**
 * Fixed physical names shared by the primary (us-east-1) and secondary
 * (us-west-2) stacks. Both stacks address these resources by name, so no
 * cross-region CloudFormation references (exports / SSM shims) are needed.
 */
export const PRIMARY_REGION = 'us-east-1';
export const SECONDARY_REGION = 'us-west-2';

/** Aurora Global Database identifier (created by the primary stack). */
export const GLOBAL_CLUSTER_ID = 'loan-aurora-global';

/** Generated master credentials; replicated by Secrets Manager to the secondary region. */
export const DB_SECRET_NAME = 'loan-aurora/db-credentials';

/** Event stream (primary region only; secondary command Lambdas publish cross-region). */
export const KINESIS_STREAM_NAME = 'loan-events-aurora';

export const DB_NAME = 'loans';
export const DB_USERNAME = 'loanadmin';

/**
 * Engine version used by BOTH clusters. A global secondary must run exactly
 * the same engine version as the primary. 16.6 supports global write
 * forwarding for Aurora PostgreSQL (>= 16.4).
 */
export const AURORA_ENGINE_VERSION = rds.AuroraPostgresEngineVersion.VER_16_6;

/** Serverless v2 capacity range (ACUs) for every instance in both regions. */
export const SERVERLESS_V2_MIN_ACU = 0.5;
export const SERVERLESS_V2_MAX_ACU = 4;
