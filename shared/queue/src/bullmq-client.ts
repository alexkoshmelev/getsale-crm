import { Queue, Worker, Job, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { createLogger, type Logger } from '@getsale/logger';
import type { JobDefinition, RecurringJobDefinition } from './types';

export interface BullMQConfig {
  redis?: ConnectionOptions | string;
  defaultJobOptions?: {
    attempts?: number;
    backoff?: { type: 'exponential' | 'fixed'; delay: number };
    removeOnComplete?: boolean | number;
    removeOnFail?: boolean | number;
  };
  log?: Logger;
}

function resolveConnection(redis?: ConnectionOptions | string): ConnectionOptions {
  if (typeof redis === 'string') {
    return { host: new URL(redis).hostname, port: parseInt(new URL(redis).port || '6379'), password: new URL(redis).password || undefined };
  }
  if (redis) return redis;
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  return { host: new URL(url).hostname, port: parseInt(new URL(url).port || '6379'), password: new URL(url).password || undefined };
}

export class JobQueue<T = unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queue: Queue<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private workers: Worker<any>[] = [];
  private log: Logger;
  private connection: ConnectionOptions;
  private defaultJobOpts: BullMQConfig['defaultJobOptions'];

  constructor(
    public readonly name: string,
    config?: BullMQConfig,
  ) {
    this.log = config?.log ?? createLogger(`bullmq:${name}`);
    this.connection = resolveConnection(config?.redis);
    this.defaultJobOpts = config?.defaultJobOptions ?? {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    };

    this.queue = new Queue(name, {
      connection: this.connection,
      defaultJobOptions: this.defaultJobOpts,
    });

    this.log.info({ message: `Job queue "${name}" created` });
  }

  async add(job: JobDefinition<T>): Promise<Job<T>> {
    return this.queue.add(job.name, job.data, {
      ...this.defaultJobOpts,
      ...job.opts,
    }) as Promise<Job<T>>;
  }

  async addBulk(jobs: JobDefinition<T>[]): Promise<Job<T>[]> {
    return this.queue.addBulk(
      jobs.map((j) => ({
        name: j.name,
        data: j.data as Record<string, unknown>,
        opts: { ...this.defaultJobOpts, ...j.opts },
      })),
    ) as Promise<Job<T>[]>;
  }

  async addRecurring(job: RecurringJobDefinition<T>): Promise<void> {
    await this.queue.upsertJobScheduler(
      job.opts?.jobId || job.name,
      job.pattern ? { pattern: job.pattern } : { every: job.every! },
      { name: job.name, data: job.data as Record<string, unknown>, opts: { ...this.defaultJobOpts, ...job.opts } },
    );
    this.log.info({ message: `Recurring job scheduled: ${job.name}`, pattern: job.pattern, every: job.every });
  }

  async removeRecurring(jobId: string): Promise<void> {
    await this.queue.removeJobScheduler(jobId);
  }

  async removeByPattern(pattern: string): Promise<number> {
    const waiting = await this.queue.getJobs(['waiting', 'delayed']);
    let removed = 0;
    for (const job of waiting) {
      if (job.name.includes(pattern) || job.id?.includes(pattern)) {
        await job.remove();
        removed++;
      }
    }
    return removed;
  }

  process(
    handler: (job: Job<T>) => Promise<unknown>,
    concurrency = 1,
  ): Worker {
    const worker = new Worker(this.name, handler as (job: Job) => Promise<unknown>, {
      connection: this.connection,
      concurrency,
    });

    worker.on('completed', (job) => {
      this.log.info({ message: `Job completed: ${job.name}`, job_id: job.id });
    });

    worker.on('failed', (job, err) => {
      this.log.error({
        message: `Job failed: ${job?.name}`,
        job_id: job?.id,
        error: err.message,
        attempt: job?.attemptsMade,
      });
    });

    worker.on('error', (err) => {
      this.log.error({ message: `Worker error on queue ${this.name}`, error: String(err) });
    });

    this.workers.push(worker);
    this.log.info({ message: `Worker started for queue "${this.name}" (concurrency: ${concurrency})` });
    return worker;
  }

  async getQueueStats(): Promise<{ waiting: number; active: number; delayed: number; failed: number; completed: number }> {
    const [waiting, active, delayed, failed, completed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getDelayedCount(),
      this.queue.getFailedCount(),
      this.queue.getCompletedCount(),
    ]);
    return { waiting, active, delayed, failed, completed };
  }

  async drain(): Promise<void> {
    await this.queue.drain();
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await this.queue.close();
    this.log.info({ message: `Queue "${this.name}" closed` });
  }
}
