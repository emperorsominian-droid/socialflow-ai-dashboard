/**
 * migrationService.test.ts — coverage for the admin migration runner (issue #1240).
 *
 * backend/src/admin/migrationService.ts backs the /admin/migrations routes
 * and can run destructive, stateful operations against Redis, so this suite
 * exercises the list/status, run (including dry-run, checksum-mismatch, and
 * failure), and rollback code paths against a fully mocked ioredis client —
 * no real Redis connection is ever made.
 */

jest.mock('ioredis', () => {
  const mockInstance = {
    smembers: jest.fn(),
    hget: jest.fn(),
    hset: jest.fn(),
    sadd: jest.fn(),
    srem: jest.fn(),
    hdel: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    sismember: jest.fn(),
    disconnect: jest.fn(),
  };
  const MockRedis = jest.fn(() => mockInstance);
  (MockRedis as unknown as { __mockInstance: typeof mockInstance }).__mockInstance = mockInstance;
  return { __esModule: true, default: MockRedis };
});

jest.mock('../../config/runtime', () => ({
  getConfiguredQueueNames: jest.fn(() => []),
  getRedisConnection: jest.fn(() => ({ host: 'localhost', port: 6379 })),
}));

import Redis from 'ioredis';
import {
  ADMIN_MIGRATIONS_SET_KEY,
  KNOWN_QUEUES_SET_KEY,
  ADMIN_MIGRATIONS_LOCK_KEY,
} from '../constants';
import { getConfiguredQueueNames } from '../../config/runtime';
import { listMigrations, runMigrations, rollbackMigration } from '../migrationService';

// The only migration currently registered in migrationService.ts. If a new
// migration is added, this constant (and any tests relying on there being
// exactly one migration) will need updating.
const MIGRATION_NAME = '20260324_sync_configured_queues';

const mockRedis = (Redis as unknown as { __mockInstance: Record<string, jest.Mock> })
  .__mockInstance;

const fakeLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  // Sensible defaults: lock is free, nothing applied yet, no stored metadata.
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.smembers.mockResolvedValue([]);
  mockRedis.hget.mockResolvedValue(null);
  mockRedis.hset.mockResolvedValue('OK');
  mockRedis.sadd.mockResolvedValue(1);
  mockRedis.srem.mockResolvedValue(1);
  mockRedis.hdel.mockResolvedValue(1);
  mockRedis.del.mockResolvedValue(1);
  mockRedis.sismember.mockResolvedValue(0);
  (getConfiguredQueueNames as jest.Mock).mockReturnValue(['queue-a', 'queue-b']);
});

describe('listMigrations', () => {
  it('reports a migration as unapplied when it has never run', async () => {
    const statuses = await listMigrations();

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      name: MIGRATION_NAME,
      applied: false,
      checksum: undefined,
      appliedAt: undefined,
    });
  });

  it('reports applied status and metadata once the migration has run', async () => {
    mockRedis.smembers.mockResolvedValue([MIGRATION_NAME]);
    mockRedis.hget.mockResolvedValue(
      JSON.stringify({ name: MIGRATION_NAME, checksum: 'abc123', appliedAt: 111, durationMs: 5 }),
    );

    const statuses = await listMigrations();

    expect(statuses[0]).toMatchObject({
      name: MIGRATION_NAME,
      applied: true,
      checksum: 'abc123',
      appliedAt: 111,
    });
  });
});

describe('runMigrations — list/status/run paths', () => {
  it('executes a pending migration and marks it applied', async () => {
    const result = await runMigrations({}, fakeLogger);

    expect(result).toMatchObject({ executed: [MIGRATION_NAME], skipped: [], failed: [], dryRun: false, lockAcquired: true });
    expect(mockRedis.sadd).toHaveBeenCalledWith(KNOWN_QUEUES_SET_KEY, 'queue-a', 'queue-b');
    expect(mockRedis.sadd).toHaveBeenCalledWith(ADMIN_MIGRATIONS_SET_KEY, MIGRATION_NAME);
    expect(mockRedis.hset).toHaveBeenCalled();
    // Lock must be released after a real (non-dry-run) run.
    expect(mockRedis.del).toHaveBeenCalledWith(ADMIN_MIGRATIONS_LOCK_KEY);
  });

  it('skips a migration that is already applied when force is not set', async () => {
    mockRedis.smembers.mockResolvedValue([MIGRATION_NAME]);

    const result = await runMigrations({}, fakeLogger);

    expect(result.executed).toEqual([]);
    expect(result.skipped).toEqual([MIGRATION_NAME]);
    expect(mockRedis.sadd).not.toHaveBeenCalled();
  });

  it('re-runs an already-applied migration when force is set', async () => {
    mockRedis.smembers.mockResolvedValue([MIGRATION_NAME]);
    mockRedis.hget.mockResolvedValue(
      JSON.stringify({ name: MIGRATION_NAME, checksum: 'stale-checksum', appliedAt: 1, durationMs: 1 }),
    );

    const result = await runMigrations({ force: true }, fakeLogger);

    expect(result.executed).toEqual([MIGRATION_NAME]);
    expect(result.failed).toEqual([]);
  });

  it('filters to a single named migration', async () => {
    const result = await runMigrations({ name: MIGRATION_NAME }, fakeLogger);
    expect(result.executed).toEqual([MIGRATION_NAME]);
  });

  it('reports lockAcquired: false and does nothing when the lock cannot be obtained', async () => {
    jest.useFakeTimers();
    mockRedis.set.mockResolvedValue(null); // lock is always held by someone else

    const runPromise = runMigrations({}, fakeLogger);
    await jest.advanceTimersByTimeAsync(35_000);
    const result = await runPromise;

    expect(result).toEqual({ executed: [], skipped: [], failed: [], dryRun: false, lockAcquired: false });
    expect(mockRedis.sadd).not.toHaveBeenCalled();

    jest.useRealTimers();
  }, 15_000);

  describe('dry run', () => {
    it('reports the migration as executed without running its side effects', async () => {
      const result = await runMigrations({ dryRun: true }, fakeLogger);

      expect(result.dryRun).toBe(true);
      expect(result.executed).toEqual([MIGRATION_NAME]);
      // The migration's own run() body (which calls redis.sadd on the known-
      // queues set) must not have executed in dry-run mode.
      expect(mockRedis.sadd).not.toHaveBeenCalled();
      expect(getConfiguredQueueNames).not.toHaveBeenCalled();
    });
  });
});

describe('runMigrations — error handling', () => {
  it('marks a migration failed and records the error when it throws', async () => {
    mockRedis.sadd.mockRejectedValueOnce(new Error('Redis unavailable'));

    const result = await runMigrations({}, fakeLogger);

    expect(result.executed).toEqual([]);
    expect(result.failed).toEqual([MIGRATION_NAME]);
    expect(result.errors).toEqual({ [MIGRATION_NAME]: 'Redis unavailable' });
    // Failure metadata is still persisted, and the lock is still released.
    expect(mockRedis.hset).toHaveBeenCalled();
    expect(mockRedis.del).toHaveBeenCalledWith(ADMIN_MIGRATIONS_LOCK_KEY);
  });

  it('marks a migration failed when the stored checksum does not match (tamper detection)', async () => {
    mockRedis.hget.mockResolvedValue(
      JSON.stringify({ name: MIGRATION_NAME, checksum: 'tampered-checksum', appliedAt: 1, durationMs: 1 }),
    );

    const result = await runMigrations({}, fakeLogger);

    expect(result.failed).toEqual([MIGRATION_NAME]);
    expect(result.errors?.[MIGRATION_NAME]).toMatch(/Checksum validation failed/);
    expect(mockRedis.sadd).not.toHaveBeenCalled();
  });

  it('bypasses a checksum mismatch when force is set', async () => {
    mockRedis.hget.mockResolvedValue(
      JSON.stringify({ name: MIGRATION_NAME, checksum: 'tampered-checksum', appliedAt: 1, durationMs: 1 }),
    );

    const result = await runMigrations({ force: true }, fakeLogger);

    expect(result.executed).toEqual([MIGRATION_NAME]);
    expect(result.failed).toEqual([]);
  });
});

describe('rollbackMigration', () => {
  it('returns an error for an unknown migration name', async () => {
    const result = await rollbackMigration('does-not-exist', fakeLogger);
    expect(result).toEqual({ success: false, error: 'Migration not found' });
  });

  it('returns an error when the migration was never applied', async () => {
    mockRedis.sismember.mockResolvedValue(0);
    const result = await rollbackMigration(MIGRATION_NAME, fakeLogger);
    expect(result).toEqual({ success: false, error: 'Migration not applied' });
  });

  it('rolls back an applied migration successfully', async () => {
    mockRedis.sismember.mockResolvedValue(1);

    const result = await rollbackMigration(MIGRATION_NAME, fakeLogger);

    expect(result).toEqual({ success: true });
    expect(mockRedis.del).toHaveBeenCalledWith(KNOWN_QUEUES_SET_KEY);
    expect(mockRedis.srem).toHaveBeenCalledWith(ADMIN_MIGRATIONS_SET_KEY, MIGRATION_NAME);
    expect(mockRedis.hdel).toHaveBeenCalledWith(expect.any(String), MIGRATION_NAME);
  });

  it('returns success: false and captures the error when rollback throws', async () => {
    mockRedis.sismember.mockResolvedValue(1);
    mockRedis.del.mockRejectedValueOnce(new Error('rollback boom'));

    const result = await rollbackMigration(MIGRATION_NAME, fakeLogger);

    expect(result).toEqual({ success: false, error: 'rollback boom' });
    expect(fakeLogger.error).toHaveBeenCalled();
  });
});
