import type { Pool } from 'pg';
import type { Logger } from '@getsale/logger';
import type { RabbitMQClient } from '@getsale/queue';
import type { RedisClient } from '@getsale/cache';
import type { TelegramClient } from 'telegram';

/**
 * Dependencies for `syncHistory` once it is moved out of `AccountActor`.
 * Fields will be aligned with the real implementation in a follow-up refactor.
 */
export interface SyncHandlerDeps {
  organizationId: string;
  accountId: string;
  pool: Pool;
  log: Logger;
  rabbitmq: RabbitMQClient;
  redis: RedisClient | null;
  client: TelegramClient | null;
}

/**
 * Placeholder for extracted sync history logic from `AccountActor.syncHistory`.
 */
export async function handleSyncHistory(_deps: SyncHandlerDeps): Promise<void> {
  // Implementation to be moved from AccountActor in a future refactor.
}
