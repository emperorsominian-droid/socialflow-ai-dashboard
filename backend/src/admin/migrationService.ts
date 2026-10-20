import type Redis from 'ioredis';
import crypto from 'crypto';
import { getConfiguredQueueNames } from '../config/runtime';
import { redis } from '../lib/redis';
import { Logger } from '../lib/logger';
import {
  ADMIN_MIGRATIONS_SET_KEY,
  KNOWN_QUEUES_SET_KEY,
  ADMIN_MIGRATIONS_LOCK_KEY,
  ADMIN_MIGRATIONS_METADATA_KEY,
  MIGRATION_LOCK_TIMEOUT_MS,
  MIGRATION_LOCK_RETRY_INTERVAL_MS,
  MIGRATION_LOCK_MAX_RETRIES,
} from './constants';

interface MigrationContext {
  redis: Redis;
  logger: Logger;
}

interface MigrationDefinition {
  name: string;
  description: string;
  run: (context: MigrationContext) => Promise<Record<string, unknown>>;
  rollback?: (context: MigrationContext) => Promise<void>;
}

export interface MigrationStatus {
  name: string;
  description: string;
  applied: boolean;
  checksum?: string;
  appliedAt?: number;
  error?: string;
}

export interface MigrationMetadata {
  name: string;
  checksum: string;
  appliedAt: number;
  durationMs: number;
  result?: Record<string, unknown>;
  error?: string;
}

export interface RunMigrationsOptions {
  name?: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface RunMigrationsResult {
  executed: string[];
  skipped: string[];
  failed: string[];
  dryRun: boolean;
  lockAcquired: boolean;
  errors?: Record<string, string>;
}

// Calculate checksum of a migration function to detect modifications
function calculateMigrationChecksum(migration: MigrationDefinition): string {
  const content = migration.run.toString();
  return crypto.createHash('sha256').update(content).digest('hex');
}

const migrations: MigrationDefinition[] = [
  {
    name: '20260324_sync_configured_queues',
    description: 'Persist configured BullMQ queue names in Redis for admin tooling discovery.',
    run: async ({ redis, logger }) => {
      const queueNames = getConfiguredQueueNames();

      if (queueNames.length === 0) {
        logger.warn('No configured queues were found while running migration', {
          migration: '20260324_sync_configured_queues',
        });

        return { syncedQueues: 0 };
      }

      const syncedQueues = await redis.sadd(KNOWN_QUEUES_SET_KEY, ...queueNames);
      logger.info('Persisted configured queues for admin discovery', {
        migration: '20260324_sync_configured_queues',
        queueNames,
        syncedQueues,
      });

      return { syncedQueues };
    },
    rollback: async ({ redis, logger }) => {
      await redis.del(KNOWN_QUEUES_SET_KEY);
      logger.info('Rolled back migration: removed known-queues set', {
        migration: '20260324_sync_configured_queues',
      });
    },
  },
];

// Attempt to acquire migration lock with exponential backoff
async function acquireMigrationLock(
  redis: Redis,
  logger: Logger,
  timeoutMs: number = MIGRATION_LOCK_TIMEOUT_MS,
  maxRetries: number = MIGRATION_LOCK_MAX_RETRIES,
): Promise<boolean> {
  const lockId = crypto.randomUUID();
  const lockAcquiredAt = Date.now();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const lockSet = await redis.set(
      ADMIN_MIGRATIONS_LOCK_KEY,
      lockId,
      'PX',
      timeoutMs,
      'NX', // Only set if key doesn't exist
    );

    if (lockSet === 'OK') {
      logger.info('Migration lock acquired', {
        lockId,
        attempt,
        attempts: maxRetries,
      });
      return true;
    }

    if (attempt < maxRetries - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, MIGRATION_LOCK_RETRY_INTERVAL_MS),
      );
    }
  }

  const elapsedMs = Date.now() - lockAcquiredAt;
  logger.warn('Failed to acquire migration lock', {
    maxRetries,
    elapsedMs,
  });
  return false;
}

// Release migration lock if we still own it
async function releaseMigrationLock(redis: Redis, logger: Logger): Promise<void> {
  // Use DEL to remove the lock
  const deleted = await redis.del(ADMIN_MIGRATIONS_LOCK_KEY);
  if (deleted > 0) {
    logger.debug('Migration lock released');
  }
}

// Retrieve migration metadata from Redis
async function getMigrationMetadata(
  redis: Redis,
  migrationName: string,
): Promise<MigrationMetadata | null> {
  const metadataJson = await redis.hget(ADMIN_MIGRATIONS_METADATA_KEY, migrationName);
  if (!metadataJson) {
    return null;
  }
  try {
    return JSON.parse(metadataJson);
  } catch {
    return null;
  }
}

// Store migration metadata in Redis
async function storeMigrationMetadata(
  redis: Redis,
  metadata: MigrationMetadata,
): Promise<void> {
  await redis.hset(
    ADMIN_MIGRATIONS_METADATA_KEY,
    metadata.name,
    JSON.stringify(metadata),
  );
}

// Validate migration checksum against stored metadata
async function validateMigrationChecksum(
  redis: Redis,
  migration: MigrationDefinition,
  logger: Logger,
): Promise<boolean> {
  const currentChecksum = calculateMigrationChecksum(migration);
  const metadata = await getMigrationMetadata(redis, migration.name);

  if (!metadata) {
    // Migration not yet applied, so no checksum to validate
    return true;
  }

  if (metadata.checksum !== currentChecksum) {
    logger.warn('Migration checksum mismatch detected', {
      migration: migration.name,
      storedChecksum: metadata.checksum,
      currentChecksum,
    });
    return false;
  }

  return true;
}

export const listMigrations = async (): Promise<MigrationStatus[]> => {
  const applied = new Set(await redis.smembers(ADMIN_MIGRATIONS_SET_KEY));

  const statuses: MigrationStatus[] = [];
  for (const migration of migrations) {
    const metadata = await getMigrationMetadata(redis, migration.name);
    statuses.push({
      name: migration.name,
      description: migration.description,
      applied: applied.has(migration.name),
      checksum: metadata?.checksum,
      appliedAt: metadata?.appliedAt,
      error: metadata?.error,
    });
  }

  return statuses;
};

export const runMigrations = async (
  options: RunMigrationsOptions,
  logger: Logger,
): Promise<RunMigrationsResult> => {
  const errors: Record<string, string> = {};

  // Attempt to acquire lock
  const lockAcquired = await acquireMigrationLock(redis, logger);
  if (!lockAcquired && !options.dryRun) {
    logger.error('Could not acquire migration lock - another migration may be in progress');
    return {
      executed: [],
      skipped: [],
      failed: [],
      dryRun: false,
      lockAcquired: false,
    };
  }

  try {
    const applied = new Set(await redis.smembers(ADMIN_MIGRATIONS_SET_KEY));
    const matchingMigrations = migrations.filter(
      (migration) => !options.name || migration.name === options.name,
    );
    const pending = matchingMigrations.filter(
      (migration) => !applied.has(migration.name) || options.force,
    );

    if (pending.length === 0) {
      return {
        executed: [],
        skipped: matchingMigrations.map((migration) => migration.name),
        failed: [],
        dryRun: Boolean(options.dryRun),
        lockAcquired: true,
      };
    }

    const executed: string[] = [];
    const failed: string[] = [];

    for (const migration of pending) {
      try {
        logger.info('Running migration', {
          migration: migration.name,
          dryRun: Boolean(options.dryRun),
        });

        // Validate checksum if migration was previously applied
        const isValid = await validateMigrationChecksum(redis, migration, logger);
        if (!isValid && !options.force) {
          const errorMsg = `Checksum validation failed - migration may have been modified`;
          logger.error('Migration checksum validation failed', {
            migration: migration.name,
            error: errorMsg,
          });
          errors[migration.name] = errorMsg;
          failed.push(migration.name);
          continue;
        }

        if (!options.dryRun) {
          const startTime = Date.now();
          try {
            const result = await migration.run({ redis, logger });
            const durationMs = Date.now() - startTime;

            // Store metadata for this migration
            const currentChecksum = calculateMigrationChecksum(migration);
            const metadata: MigrationMetadata = {
              name: migration.name,
              checksum: currentChecksum,
              appliedAt: Date.now(),
              durationMs,
              result,
            };

            await storeMigrationMetadata(redis, metadata);
            await redis.sadd(ADMIN_MIGRATIONS_SET_KEY, migration.name);

            logger.info('Migration completed successfully', {
              migration: migration.name,
              durationMs,
            });
            executed.push(migration.name);
          } catch (migrationError) {
            const errorMsg =
              migrationError instanceof Error
                ? migrationError.message
                : String(migrationError);

            logger.error('Migration failed', {
              migration: migration.name,
              error: errorMsg,
            });

            // Store error metadata
            const currentChecksum = calculateMigrationChecksum(migration);
            const metadata: MigrationMetadata = {
              name: migration.name,
              checksum: currentChecksum,
              appliedAt: Date.now(),
              durationMs: Date.now() - startTime,
              error: errorMsg,
            };

            await storeMigrationMetadata(redis, metadata);
            errors[migration.name] = errorMsg;
            failed.push(migration.name);
          }
        } else {
          executed.push(migration.name);
        }
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        logger.error('Unexpected error processing migration', {
          migration: migration.name,
          error: errorMsg,
        });
        errors[migration.name] = errorMsg;
        failed.push(migration.name);
      }
    }

    return {
      executed,
      skipped: matchingMigrations
        .filter((migration) => applied.has(migration.name) && !options.force)
        .map((migration) => migration.name),
      failed,
      dryRun: Boolean(options.dryRun),
      lockAcquired: true,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
    };
  } finally {
    if (!options.dryRun) {
      await releaseMigrationLock(redis, logger);
    }
  }
};

export const rollbackMigration = async (
  migrationName: string,
  logger: Logger,
): Promise<{ success: boolean; error?: string }> => {
  try {
    const migration = migrations.find((m) => m.name === migrationName);
    if (!migration) {
      return { success: false, error: 'Migration not found' };
    }

    if (!migration.rollback) {
      return { success: false, error: 'Migration does not support rollback' };
    }

    const applied = await redis.sismember(ADMIN_MIGRATIONS_SET_KEY, migrationName);
    if (!applied) {
      return { success: false, error: 'Migration not applied' };
    }

    await migration.rollback({ redis, logger });
    await redis.srem(ADMIN_MIGRATIONS_SET_KEY, migrationName);
    await redis.hdel(ADMIN_MIGRATIONS_METADATA_KEY, migrationName);

    logger.info('Migration rolled back successfully', { migration: migrationName });
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Rollback failed', { migration: migrationName, error: errorMsg });
    return { success: false, error: errorMsg };
  }
};
