import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { RedisClient } from '@getsale/cache';
import { RabbitMQClient } from '@getsale/queue';
import { AccountActor, AccountActorConfig } from './account-actor';

const LOCK_TTL_SECONDS = 60;
const LOCK_REFRESH_INTERVAL = 20_000;
const DISCOVERY_INTERVAL = 30_000;

/**
 * SessionCoordinator discovers active BD accounts, acquires distributed Redis locks,
 * and starts an AccountActor for each account owned by this instance.
 * Supports horizontal scaling: multiple TSM instances share accounts via locks.
 */
export class SessionCoordinator {
  private actors = new Map<string, AccountActor>();
  private locks = new Map<string, string>();
  private pool: Pool;
  private rabbitmq: RabbitMQClient;
  private redis: RedisClient;
  private log: Logger;
  private instanceId: string;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private running = false;
  private apiId: number;
  private apiHash: string;

  constructor(config: {
    pool: Pool;
    rabbitmq: RabbitMQClient;
    redis: RedisClient;
    log: Logger;
    instanceId: string;
    apiId: number;
    apiHash: string;
  }) {
    this.pool = config.pool;
    this.rabbitmq = config.rabbitmq;
    this.redis = config.redis;
    this.log = config.log;
    this.instanceId = config.instanceId;
    this.apiId = config.apiId;
    this.apiHash = config.apiHash;
  }

  async start(): Promise<void> {
    this.running = true;
    this.log.info({ message: `Coordinator started (instance: ${this.instanceId})` });

    await this.discoverAndClaim();

    this.discoveryTimer = setInterval(() => this.discoverAndClaim(), DISCOVERY_INTERVAL);
    this.refreshTimer = setInterval(() => this.refreshLocks(), LOCK_REFRESH_INTERVAL);
  }

  private async discoverAndClaim(): Promise<void> {
    if (!this.running) return;

    try {
      const result = await this.pool.query(
        "SELECT id, organization_id FROM bd_accounts WHERE is_active = true AND session_string IS NOT NULL",
      );

      for (const row of result.rows) {
        const accountId = row.id as string;
        if (this.actors.has(accountId)) continue;

        const lockKey = `tsm:lock:${accountId}`;
        const acquired = await this.redis.tryLock(lockKey, this.instanceId, LOCK_TTL_SECONDS);

        if (acquired) {
          this.locks.set(accountId, lockKey);
          const actor = new AccountActor({
            accountId,
            organizationId: row.organization_id,
            pool: this.pool,
            rabbitmq: this.rabbitmq,
            redis: this.redis,
            log: this.log,
            apiId: this.apiId,
            apiHash: this.apiHash,
          });
          this.actors.set(accountId, actor);
          actor.start().catch((err) => {
            this.log.error({ message: `Failed to start actor for ${accountId}`, error: String(err) });
            this.releaseAccount(accountId);
          });
          this.log.info({ message: `Claimed account ${accountId}` });
        }
      }

      // Release accounts that are no longer active
      for (const [accountId] of this.actors) {
        const exists = result.rows.some((r: { id: string }) => r.id === accountId);
        if (!exists) {
          this.log.info({ message: `Account ${accountId} no longer active, releasing` });
          await this.releaseAccount(accountId);
        }
      }
    } catch (err) {
      this.log.error({ message: 'Discovery failed', error: String(err) });
    }
  }

  private async refreshLocks(): Promise<void> {
    for (const [accountId, lockKey] of this.locks) {
      const refreshed = await this.redis.refreshLock(lockKey, this.instanceId, LOCK_TTL_SECONDS);
      if (!refreshed) {
        this.log.warn({ message: `Lost lock for ${accountId}, stopping actor` });
        await this.releaseAccount(accountId);
      }
    }
  }

  private async releaseAccount(accountId: string): Promise<void> {
    const actor = this.actors.get(accountId);
    if (actor) {
      await actor.stop().catch(() => {});
      this.actors.delete(accountId);
    }
    const lockKey = this.locks.get(accountId);
    if (lockKey) {
      await this.redis.releaseLock(lockKey, this.instanceId);
      this.locks.delete(accountId);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);

    const stopPromises = Array.from(this.actors.keys()).map((id) => this.releaseAccount(id));
    await Promise.allSettled(stopPromises);
    this.log.info({ message: 'Coordinator stopped' });
  }

  getActorCount(): number {
    return this.actors.size;
  }

  getActor(accountId: string): AccountActor | undefined {
    return this.actors.get(accountId);
  }

  getActorStates(): Record<string, string> {
    const states: Record<string, string> = {};
    for (const [id, actor] of this.actors) {
      states[id] = actor.state;
    }
    return states;
  }
}
