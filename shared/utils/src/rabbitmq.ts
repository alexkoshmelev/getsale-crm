import amqp from 'amqplib';
import { Event, EventType } from '@getsale/events';

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection['createChannel']>>;

export class RabbitMQClient {
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async connect(retries: number = 10, initialDelay: number = 1000): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const conn = await amqp.connect(this.url, {
          heartbeat: 60,
          connection_timeout: 10000,
        });
        this.connection = conn;
        this.channel = await conn.createChannel();
        
        this.connection.on('error', (err) => {
          console.error('RabbitMQ connection error:', err);
        });

        this.connection.on('close', () => {
          console.log('RabbitMQ connection closed');
        });

        console.log('Successfully connected to RabbitMQ');
        return;
      } catch (error: any) {
        if (attempt === retries) {
          console.error(`Failed to connect to RabbitMQ after ${retries} attempts:`, error);
          throw error;
        }
        // Exponential backoff: delay increases with each attempt
        const delay = initialDelay * Math.pow(2, attempt - 1);
        console.log(`RabbitMQ connection attempt ${attempt}/${retries} failed, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async publishEvent(event: Event, exchange: string = 'events'): Promise<void> {
    if (!this.channel) {
      console.warn('RabbitMQ channel not initialized, event not published:', event.type);
      return;
    }

    await this.channel.assertExchange(exchange, 'topic', { durable: true });
    
    const routingKey = event.type;
    const message = JSON.stringify({
      ...event,
      timestamp: event.timestamp.toISOString(),
    });

    this.channel.publish(exchange, routingKey, Buffer.from(message), {
      persistent: true,
      messageId: event.id,
      timestamp: Date.now(),
    });
  }

  async subscribeToEvents(
    eventTypes: EventType[],
    handler: (event: Event) => Promise<void>,
    exchange: string = 'events',
    queueName?: string
  ): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not initialized');
    }

    await this.channel.assertExchange(exchange, 'topic', { durable: true });
    
    const queue = queueName || `queue.${Date.now()}`;
    await this.channel.assertQueue(queue, { durable: true });

    for (const eventType of eventTypes) {
      await this.channel.bindQueue(queue, exchange, eventType);
    }

    await this.channel.consume(queue, async (msg) => {
      if (!msg) return;

      try {
        const event = JSON.parse(msg.content.toString());
        event.timestamp = new Date(event.timestamp);
        await handler(event);
        this.channel!.ack(msg);
      } catch (error) {
        console.error('Error processing event:', error);
        this.channel!.nack(msg, false, true); // Requeue on error
      }
    });
  }

  async close(): Promise<void> {
    if (this.channel) {
      await this.channel.close();
    }
    if (this.connection) {
      await this.connection.close();
    }
  }
}

