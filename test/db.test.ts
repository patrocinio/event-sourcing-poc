/**
 * src/shared/db.ts — pool configuration per endpoint role, incl. the Aurora
 * Global Database write-forwarding session setup. pg and Secrets Manager are
 * mocked; no network access.
 */
const poolConfigs: Array<Record<string, unknown>> = [];

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation((config: Record<string, unknown>) => {
    poolConfigs.push(config);
    return { on: jest.fn(), query: jest.fn(), connect: jest.fn() };
  }),
}));

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      SecretString: JSON.stringify({ username: 'u', password: 'p', port: 5432 }),
    }),
  })),
  GetSecretValueCommand: jest.fn(),
}));

type DbModule = typeof import('../src/shared/db');

function loadDb(env: Record<string, string | undefined>): DbModule {
  poolConfigs.length = 0;
  process.env = {
    ...ORIGINAL_ENV,
    DB_SECRET_ARN: 'arn:aws:secretsmanager:us-west-2:111111111111:secret:loan-aurora/db-credentials',
    DB_WRITER_HOST: 'writer.example',
    DB_READER_HOST: 'reader.example',
    DB_NAME: 'loans',
    ...env,
  };
  let mod!: DbModule;
  jest.isolateModules(() => {
    mod = require('../src/shared/db');
  });
  return mod;
}

const ORIGINAL_ENV = process.env;
afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('getPool', () => {
  it('always verifies TLS certificates', async () => {
    const db = loadDb({});
    await db.getPool('writer');
    await db.getPool('reader');
    for (const cfg of poolConfigs) expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('adds no session hook when write forwarding is off (primary region)', async () => {
    const db = loadDb({ DB_WRITE_FORWARDING: undefined });
    await db.getPool('writer');
    expect(poolConfigs[0].host).toBe('writer.example');
    expect(poolConfigs[0].onConnect).toBeUndefined();
  });

  it('sets SESSION consistency on every new WRITER connection when forwarding is on', async () => {
    const db = loadDb({ DB_WRITE_FORWARDING: 'true' });
    await db.getPool('writer');
    const onConnect = poolConfigs[0].onConnect as (c: unknown) => Promise<void>;
    expect(typeof onConnect).toBe('function');

    const client = { query: jest.fn().mockResolvedValue({}) };
    await onConnect(client);
    expect(client.query).toHaveBeenCalledWith(
      "SET apg_write_forward.consistency_mode = 'SESSION'"
    );
  });

  it('rejects the connection when the SET fails (never hands out an unconfigured session)', async () => {
    const db = loadDb({ DB_WRITE_FORWARDING: 'true' });
    await db.getPool('writer');
    const onConnect = poolConfigs[0].onConnect as (c: unknown) => Promise<void>;
    const client = { query: jest.fn().mockRejectedValue(new Error('boom')) };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(onConnect(client)).rejects.toThrow('boom');
    spy.mockRestore();
  });

  it('does not touch the READER pool when forwarding is on', async () => {
    const db = loadDb({ DB_WRITE_FORWARDING: 'true' });
    await db.getPool('reader');
    expect(poolConfigs[0].host).toBe('reader.example');
    expect(poolConfigs[0].onConnect).toBeUndefined();
  });
});
