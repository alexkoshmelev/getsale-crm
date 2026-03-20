import amqp from 'amqplib';
import { Counter } from 'prom-client';
import { Event, EventType } from '@getsale/events';
import { createLogger, type Logger } from '@getsale/logger';

/** Register with service registry for /metrics (see createServiceApp). */
export const rabbitmqDlqMessagesTotal = new Counter({
  name: 'rabbitmq_dlq_messages_total',
  help: 'Total messages sent to dead letter queues after max consumer retries',
  labelNames: ['queue'] as const,
  registers: [],
});

/** Counter for event publish failures. Register with service registry for /metrics: registry.registerMetric(eventPublishFailedTotal). */
export const eventPublishFailedTotal = new Counter({
  name: 'event_publish_failed_total',
  help: 'Total event publish failures (channel down, write error)',
  labelNames: [] as const,
  registers: [], // do not add to default registry; service should register for /metrics
});

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection['createChannel']>>;

export class RabbitMQClient {
  private connection: Connection | null = null;
  /** Dedicated channel for publishing (events, DLQ, retries) — avoids head-of-line blocking on consumer. */
  private publishChannel: Channel | null = null;
  /** Dedicated channel for consuming only (ack, prefetch). */
  private consumeChannel: Channel | null = null;
  private url: string;
  private log: Logger;

  constructor(url: string, log?: Logger) {
    this.url = url;
    this.log = log ?? createLogger('rabbitmq');
  }

  isConnected(): boolean {
    return this.connection != null && this.publishChannel != null && this.consumeChannel != null;
  }

  async connect(retries: number = 10, initialDelay: number = 1000): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const conn = await amqp.connect(this.url, {
          heartbeat: 60,
          connection_timeout: 10000,
        });
        this.connection = conn;
        this.publishChannel = await conn.createChannel();
        this.consumeChannel = await conn.createChannel();

        this.connection.on('error', (err) => {
          this.log.error({ message: 'RabbitMQ connection error', error: String(err) });
        });

        this.connection.on('close', () => {
          this.log.info({ message: 'RabbitMQ connection closed' });
        });

        this.log.info({ message: 'Successfully connected to RabbitMQ' });
        return;
      } catch (error: unknown) {
        const err = error as Error;
        if (attempt === retries) {
          this.log.error({ message: `Failed to connect to RabbitMQ after ${retries} attempts`, error: err.message });
          throw error;
        }
        const delay = initialDelay * Math.pow(2, attempt - 1);
        this.log.info({ message: `RabbitMQ connection attempt ${attempt}/${retries} failed, retrying in ${delay}ms` });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async publishEvent(event: Event, exchange: string = 'events'): Promise<void> {
    if (!this.publishChannel) {
      eventPublishFailedTotal.inc();
      this.log.warn({ message: 'RabbitMQ publish channel not initialized, event not published', event_type: event.type });
      return;
    }

    try {
      await this.publishChannel.assertExchange(exchange, 'topic', { durable: true });

      const routingKey = event.type;
      const message = JSON.stringify({
        ...event,
        timestamp: event.timestamp.toISOString(),
      });

      this.publishChannel.publish(exchange, routingKey, Buffer.from(message), {
        persistent: true,
        messageId: event.id,
        timestamp: Date.now(),
      });
    } catch (err) {
      eventPublishFailedTotal.inc();
      this.log.error({ message: 'Event publish failed', event_type: event.type, error: String(err) });
      throw err;
    }
  }

  /** Publish event to a DLQ (durable queue). Uses default exchange; queue must exist. */
  async publishToDlq(queueName: string, event: Event): Promise<void> {
    if (!this.publishChannel) {
      this.log.warn({ message: 'RabbitMQ publish channel not initialized, DLQ publish skipped', queue: queueName });
      return;
    }
    await this.publishChannel.assertQueue(queueName, { durable: true });
    const message = JSON.stringify({
      ...event,
      timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp,
    });
    this.publishChannel.sendToQueue(queueName, Buffer.from(message), {
      persistent: true,
      messageId: event.id,
      timestamp: Date.now(),
    });
  }

  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_HEADER = 'x-retry-count';

  async subscribeToEvents(
    eventTypes: EventType[],
    handler: (event: Event) => Promise<void>,
    exchange: string = 'events',
    queueName?: string
  ): Promise<void> {
    if (!this.consumeChannel || !this.publishChannel) {
      throw new Error('RabbitMQ channels not initialized');
    }

    const cons = this.consumeChannel;
    const pub = this.publishChannel;

    await cons.assertExchange(exchange, 'topic', { durable: true });

    const queue = queueName || `queue.${Date.now()}`;
    await cons.assertQueue(queue, { durable: true });

    cons.prefetch(10);

    for (const eventType of eventTypes) {
      await cons.bindQueue(queue, exchange, eventType);
    }

    const dlqName = `${queue}.dlq`;
    await cons.assertQueue(dlqName, { durable: true });

    await cons.consume(queue, async (msg) => {
      if (!msg) return;

      const retryCount = (msg.properties?.headers?.[RabbitMQClient.RETRY_HEADER] as number) ?? 0;

      try {
        const event = JSON.parse(msg.content.toString());
        event.timestamp = new Date(event.timestamp);
        await handler(event);
        cons.ack(msg);
      } catch (error) {
        this.log.error({ message: 'Error processing event', error: error instanceof Error ? error.message : String(error) });
        if (retryCount < RabbitMQClient.MAX_RETRIES) {
          pub.sendToQueue(queue, msg.content, {
            ...msg.properties,
            headers: {
              ...(msg.properties?.headers || {}),
              [RabbitMQClient.RETRY_HEADER]: retryCount + 1,
            },
          });
          cons.ack(msg);
        } else {
          try {
            const event = JSON.parse(msg.content.toString());
            event.timestamp = event.timestamp ? new Date(event.timestamp) : new Date();
            await this.publishToDlq(dlqName, event);
            rabbitmqDlqMessagesTotal.inc({ queue: dlqName });
            this.log.error({
              message: 'Message sent to DLQ after max retries',
              queue: dlqName,
              event_type: event.type,
              retries: RabbitMQClient.MAX_RETRIES,
            });
          } catch (dlqError) {
            this.log.error({
              message: 'Failed to publish message to DLQ',
              queue: dlqName,
              error: dlqError instanceof Error ? dlqError.message : String(dlqError),
            });
          }
          cons.ack(msg);
        }
      }
    });
  }

  async close(): Promise<void> {
    if (this.consumeChannel) {
      await this.consumeChannel.close().catch(() => {});
      this.consumeChannel = null;
    }
    if (this.publishChannel) {
      await this.publishChannel.close().catch(() => {});
      this.publishChannel = null;
    }
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
  }
}

