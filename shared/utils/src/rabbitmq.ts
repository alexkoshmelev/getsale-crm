import amqp from 'amqplib';
import type { Connection, Channel } from 'amqplib';
import { Event, EventType } from '@getsale/events';

export class RabbitMQClient {
  private connection: Awaited<ReturnType<typeof amqp.connect>> | null = null;
  private channel: Channel | null = null;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    try {
      const conn = await amqp.connect(this.url);
      this.connection = conn;
      this.channel = await conn.createChannel();
      
      this.connection.on('error', (err) => {
        console.error('RabbitMQ connection error:', err);
      });

      this.connection.on('close', () => {
        console.log('RabbitMQ connection closed');
      });
    } catch (error) {
      console.error('Failed to connect to RabbitMQ:', error);
      throw error;
    }
  }

  async publishEvent(event: Event, exchange: string = 'events'): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not initialized');
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

