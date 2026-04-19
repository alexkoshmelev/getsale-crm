import { DatabasePools, ServiceHttpClient } from '@getsale/service-framework';
import { RedisClient, InboxModel } from '@getsale/cache';
import { RabbitMQClient } from '@getsale/queue';
import { Logger } from '@getsale/logger';

export interface MessagingDeps {
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis: RedisClient;
  inbox: InboxModel;
  aiClient: ServiceHttpClient;
}
