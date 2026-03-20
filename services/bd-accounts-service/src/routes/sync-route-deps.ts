import type { Pool } from 'pg';
import type { Logger } from '@getsale/logger';
import type { TelegramManager } from '../telegram';

export type CheckPermissionFn = (role: string, resource: string, action: string) => Promise<boolean>;

export interface SyncRouteDeps {
  pool: Pool;
  log: Logger;
  telegramManager: TelegramManager;
  checkPermission: CheckPermissionFn;
}
