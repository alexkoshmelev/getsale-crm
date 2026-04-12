import { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { RedisClient } from '@getsale/cache';
import { EventType, type Event } from '@getsale/events';
import { JobQueue, RabbitMQClient } from '@getsale/queue';
import { CommandType } from './command-types';

export interface CampaignJobData {
  participantId: string;
  campaignId: string;
  stepIndex: number;
  bdAccountId: string;
  contactId: string;
  channelId?: string;
  organizationId: string;
  scheduledAt: number;
}

export interface JobProcessorDeps {
  pool: Pool;
  log: Logger;
  redis: RedisClient;
  rabbitmq: RabbitMQClient;
  jobQueue: JobQueue<CampaignJobData>;
}

export type { Job };
