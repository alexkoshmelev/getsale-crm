import { vi } from 'vitest';
import type { Event } from '@getsale/events';
import type { RabbitMQClient } from '@getsale/queue';

export interface PublishedEvent {
  event: Event;
  exchange?: string;
}

export type MockRabbitMQ = RabbitMQClient & {
  getPublishedEvents: () => PublishedEvent[];
};

export function createMockRabbitMQ(): MockRabbitMQ {
  const publishedEvents: PublishedEvent[] = [];

  const mock = {
    connection: null,
    channel: null,
    url: 'amqp://mock:mock@localhost:5672',
    publishEvent: vi.fn(async (event: Event, exchange: string = 'events'): Promise<void> => {
      publishedEvents.push({ event, exchange });
    }),
    publishCommand: vi.fn(async (): Promise<void> => {}),
    publishToDlq: vi.fn(async (): Promise<void> => {}),
    subscribeToEvents: vi.fn(async (): Promise<void> => {}),
    isConnected: vi.fn(() => true),
    connect: vi.fn(async (): Promise<void> => {}),
    close: vi.fn(async (): Promise<void> => {}),
    getPublishedEvents: () => [...publishedEvents],
  } as unknown as MockRabbitMQ;

  return mock;
}
