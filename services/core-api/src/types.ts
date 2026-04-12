import { DatabasePools } from '@getsale/service-framework';
import { RedisClient, CacheManager } from '@getsale/cache';
import { RabbitMQClient } from '@getsale/queue';
import { Logger } from '@getsale/logger';

export interface CoreDeps {
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis: RedisClient;
  pipelineCache: CacheManager;
  contactsCache: CacheManager;
}
