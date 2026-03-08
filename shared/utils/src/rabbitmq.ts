import amqp from 'amqplib';
import { Event, EventType } from '@getsale/events';

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection['createChannel']>>;

export class RabbitMQClient {
  private connection: Connection | null = null;
  /** Dedicated channel for publishing (events, DLQ, retries) — avoids head-of-line blocking on consumer. */
  private publishChannel: Channel | null = null;
  /** Dedicated channel for consuming only (ack, prefetch). */
  private consumeChannel: Channel | null = null;
  private url: string;

  constructor(url: string) {
    this.url = url;
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
          console.error('RabbitMQ connection error:', err);
        });

        this.connection.on('close', () => {
          console.log('RabbitMQ connection closed');
        });

        console.log('Successfully connected to RabbitMQ');
        return;
      } catch (error: unknown) {
        const err = error as Error;
        if (attempt === retries) {
          console.error(`Failed to connect to RabbitMQ after ${retries} attempts:`, err);
          throw error;
        }
        const delay = initialDelay * Math.pow(2, attempt - 1);
        console.log(`RabbitMQ connection attempt ${attempt}/${retries} failed, retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async publishEvent(event: Event, exchange: string = 'events'): Promise<void> {
    if (!this.publishChannel) {
      console.warn('RabbitMQ publish channel not initialized, event not published:', event.type);
      return;
    }

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
  }

  /** Publish event to a DLQ (durable queue). Uses default exchange; queue must exist. */
  async publishToDlq(queueName: string, event: Event): Promise<void> {
    if (!this.publishChannel) {
      console.warn('RabbitMQ publish channel not initialized, DLQ publish skipped:', queueName);
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
        console.error('Error processing event:', error);
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
          } catch (_) {
            // best effort DLQ
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

