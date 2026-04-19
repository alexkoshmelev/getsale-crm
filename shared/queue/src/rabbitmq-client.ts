import amqp from 'amqplib';
import { Counter } from 'prom-client';
import { Event, EventType } from '@getsale/events';
import { createLogger, type Logger } from '@getsale/logger';

export const eventPublishFailedTotal = new Counter({
  name: 'event_publish_failed_total',
  help: 'Total event publish failures',
  registers: [],
});

export const rabbitmqDlqMessagesTotal = new Counter({
  name: 'rabbitmq_dlq_messages_total',
  help: 'Messages sent to dead letter queues after max retries',
  labelNames: ['queue'] as const,
  registers: [],
});

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection['createChannel']>>;
type ConfirmChannel = Awaited<ReturnType<Connection['createConfirmChannel']>>;

export interface RabbitMQClientOptions {
  url?: string;
  prefetch?: number;
  maxRetries?: number;
  log?: Logger;
}

export class RabbitMQClient {
  private connection: Connection | null = null;
  private publishChannel: ConfirmChannel | null = null;
  private consumeChannel: Channel | null = null;
  private url: string;
  private defaultPrefetch: number;
  private maxRetries: number;
  private log: Logger;
  private reconnecting = false;

  constructor(urlOrOptions?: string | RabbitMQClientOptions) {
    if (typeof urlOrOptions === 'string') {
      this.url = urlOrOptions;
      this.defaultPrefetch = 10;
      this.maxRetries = 3;
      this.log = createLogger('rabbitmq');
    } else {
      const opts = urlOrOptions ?? {};
      this.url = opts.url || process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672';
      this.defaultPrefetch = opts.prefetch ?? 10;
      this.maxRetries = opts.maxRetries ?? 3;
      this.log = opts.log ?? createLogger('rabbitmq');
    }
  }

  isConnected(): boolean {
    return this.connection != null && this.publishChannel != null && this.consumeChannel != null;
  }

  async connect(retries = 10, initialDelay = 1000): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const conn = await amqp.connect(this.url, {
          heartbeat: 60,
          connection_timeout: 10_000,
        });
        this.connection = conn;
        this.publishChannel = await conn.createConfirmChannel();
        this.consumeChannel = await conn.createChannel();

        conn.on('error', (err) => {
          this.log.error({ message: 'RabbitMQ connection error', error: String(err) });
        });

        conn.on('close', () => {
          this.log.info({ message: 'RabbitMQ connection closed' });
          this.scheduleReconnect();
        });

        this.log.info({ message: 'Connected to RabbitMQ (confirm channel)' });
        return;
      } catch (error) {
        if (attempt === retries) {
          this.log.error({ message: `Failed to connect after ${retries} attempts`, error: String(error) });
          throw error;
        }
        const delay = initialDelay * Math.pow(2, attempt - 1);
        this.log.info({ message: `RabbitMQ attempt ${attempt}/${retries} failed, retrying in ${delay}ms` });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    setTimeout(async () => {
      try {
        this.connection = null;
        this.publishChannel = null;
        this.consumeChannel = null;
        await this.connect(5, 2000);
      } catch (err) {
        this.log.error({ message: 'Reconnect failed', error: String(err) });
      } finally {
        this.reconnecting = false;
      }
    }, 5000);
  }

  /**
   * Publish with publisher confirms. The returned promise resolves only after
   * RabbitMQ has confirmed the message is persisted.
   */
  async publishEvent(event: Event, exchange = 'events'): Promise<void> {
    if (!this.publishChannel) {
      eventPublishFailedTotal.inc();
      this.log.warn({ message: 'Publish channel not ready, event dropped', event_type: event.type });
      return;
    }

    try {
      await this.publishChannel.assertExchange(exchange, 'topic', { durable: true });

      const message = JSON.stringify({
        ...event,
        timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp,
      });

      const published = this.publishChannel.publish(exchange, event.type, Buffer.from(message), {
        persistent: true,
        messageId: event.id,
        timestamp: Date.now(),
      });

      if (!published) {
        await new Promise<void>((resolve) => this.publishChannel!.once('drain', resolve));
      }

      await this.publishChannel.waitForConfirms();
    } catch (err) {
      eventPublishFailedTotal.inc();
      this.log.error({ message: 'Event publish failed', event_type: event.type, error: String(err) });
      throw err;
    }
  }

  async publishToDlq(queueName: string, event: Event): Promise<void> {
    if (!this.publishChannel) return;
    await this.publishChannel.assertQueue(queueName, { durable: true });
    this.publishChannel.sendToQueue(queueName, Buffer.from(JSON.stringify({
      ...event,
      timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp,
    })), { persistent: true, messageId: event.id, timestamp: Date.now() });
    await this.publishChannel.waitForConfirms();
  }

  /**
   * Publish a command to a specific queue (not the topic exchange).
   * Used for direct command routing (e.g. telegram:commands:{account_id}).
   */
  private static readonly COMMAND_QUEUE_ARGS = {
    'x-dead-letter-exchange': 'commands.dlx',
    'x-message-ttl': 3600000,
    'x-max-length': 1000,
    'x-overflow': 'reject-publish',
  } as const;

  private commandQueueOptions(queueName: string): amqp.Options.AssertQueue {
    return {
      durable: true,
      maxPriority: 10,
      arguments: {
        ...RabbitMQClient.COMMAND_QUEUE_ARGS,
        'x-dead-letter-routing-key': queueName,
      },
    };
  }

  private async ensureCommandDlx(ch: Channel | ConfirmChannel, queueName: string): Promise<void> {
    const dlxExchange = 'commands.dlx';
    const dlqName = `${queueName}.dlq`;
    await ch.assertExchange(dlxExchange, 'direct', { durable: true });
    await ch.assertQueue(dlqName, { durable: true });
    await ch.bindQueue(dlqName, dlxExchange, queueName);
  }

  async publishCommand<T>(queueName: string, command: { type: string; payload: T; id?: string; priority?: number }): Promise<void> {
    if (!this.publishChannel) {
      this.log.warn({ message: 'Publish channel not ready, command dropped', queue: queueName, command_type: command.type });
      return;
    }
    await this.ensureCommandDlx(this.publishChannel, queueName);
    await this.publishChannel.assertQueue(queueName, this.commandQueueOptions(queueName));
    this.publishChannel.sendToQueue(
      queueName,
      Buffer.from(JSON.stringify(command)),
      { persistent: true, priority: command.priority ?? 0, messageId: command.id, timestamp: Date.now() },
    );
    await this.publishChannel.waitForConfirms();
  }

  async subscribeToEvents(
    eventTypes: EventType[],
    handler: (event: Event) => Promise<void>,
    exchange = 'events',
    queueName?: string,
    prefetch?: number,
  ): Promise<void> {
    if (!this.consumeChannel || !this.publishChannel) {
      throw new Error('RabbitMQ channels not initialized');
    }

    const cons = this.consumeChannel;
    const pub = this.publishChannel;

    await cons.assertExchange(exchange, 'topic', { durable: true });

    const queue = queueName || `queue.${Date.now()}`;
    await cons.assertQueue(queue, { durable: true });
    cons.prefetch(prefetch ?? this.defaultPrefetch);

    for (const eventType of eventTypes) {
      await cons.bindQueue(queue, exchange, eventType);
    }

    const dlqName = `${queue}.dlq`;
    await cons.assertQueue(dlqName, { durable: true });

    await cons.consume(queue, async (msg) => {
      if (!msg) return;
      const retryCount = (msg.properties?.headers?.['x-retry-count'] as number) ?? 0;

      try {
        const event = JSON.parse(msg.content.toString());
        event.timestamp = new Date(event.timestamp);
        await handler(event);
        cons.ack(msg);
      } catch (error) {
        this.log.error({ message: 'Error processing event', error: String(error), queue, retry: retryCount });

        if (retryCount < this.maxRetries) {
          const delay = 1000 * Math.pow(2, retryCount);
          setTimeout(() => {
            pub.sendToQueue(queue, msg.content, {
              ...msg.properties,
              headers: { ...(msg.properties?.headers || {}), 'x-retry-count': retryCount + 1 },
            });
          }, delay);
          cons.ack(msg);
        } else {
          try {
            const event = JSON.parse(msg.content.toString());
            event.timestamp = event.timestamp ? new Date(event.timestamp) : new Date();
            await this.publishToDlq(dlqName, event);
            rabbitmqDlqMessagesTotal.inc({ queue: dlqName });
          } catch (dlqErr) {
            this.log.error({ message: 'DLQ publish failed', queue: dlqName, error: String(dlqErr) });
          }
          cons.ack(msg);
        }
      }
    });

    this.log.info({ message: `Subscribed to events`, event_types: eventTypes.join(','), queue });
  }

  /**
   * Consume commands from a direct queue (e.g. telegram:commands:{accountId}).
   */
  async consumeQueue<T = unknown>(
    queueName: string,
    handler: (command: T) => Promise<void>,
    prefetch?: number,
  ): Promise<void> {
    if (!this.consumeChannel) throw new Error('RabbitMQ consume channel not initialized');

    const cons = this.consumeChannel;
    await this.ensureCommandDlx(cons, queueName);
    await cons.assertQueue(queueName, this.commandQueueOptions(queueName));
    cons.prefetch(prefetch ?? 1);

    await cons.consume(queueName, async (msg) => {
      if (!msg) return;
      try {
        const command = JSON.parse(msg.content.toString()) as T;
        await handler(command);
        cons.ack(msg);
      } catch (error) {
        this.log.error({ message: 'Command processing failed', queue: queueName, error: String(error) });
        cons.nack(msg, false, false);
      }
    });

    this.log.info({ message: `Consuming commands from queue`, queue: queueName });
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
