import { Router } from 'express';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { Logger } from '@getsale/logger';
import { canPermission } from '@getsale/service-core';
import { TelegramManager } from '../telegram';
import type { SyncRouteDeps } from './sync-route-deps';
import { registerSyncDialogsReadRoutes } from './sync-routes-dialogs-read';
import { registerSyncFoldersWriteRoutes } from './sync-routes-folders-write';
import { registerSyncChatsSyncRoutes } from './sync-routes-chats-sync';
import { registerSyncDiscoveryRoutes } from './sync-routes-discovery';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  telegramManager: TelegramManager;
}

/**
 * BD account sync / folders / discovery HTTP routes.
 * Handlers split across `sync-routes-*.ts` (C3); registration order matches legacy single-file order.
 */
export function syncRouter({ pool, log, telegramManager }: Deps): Router {
  const router = Router();
  const checkPermission = canPermission(pool);
  const deps: SyncRouteDeps = { pool, log, telegramManager, checkPermission };

  registerSyncDialogsReadRoutes(router, deps);
  registerSyncFoldersWriteRoutes(router, deps);
  registerSyncChatsSyncRoutes(router, deps);
  registerSyncDiscoveryRoutes(router, deps);

  return router;
}
