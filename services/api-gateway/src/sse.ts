import type { Request, Response } from 'express';
import Redis from 'ioredis';
import type { Logger } from '@getsale/logger';
import { REDIS_URL, SSE_HEARTBEAT_MS, SSE_MAX_CONNECTIONS_PER_USER } from './config';

/** Per channel (events:userId): set of response streams. Enforces per-user connection limit. */
export const sseClients = new Map<string, Set<Response>>();

let redisSub: Redis | null = null;

export function setupRedisSubscriber(log: Logger): void {
  try {
    const url = new URL(REDIS_URL);
    redisSub = new Redis({
      host: url.hostname,
      port: parseInt(url.port || '6379'),
      password: url.password || undefined,
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
    });
    redisSub.on('error', (err: Error) => log.error({ message: 'Redis subscriber error', error: String(err) }));
    redisSub.on('message', (channel: string, message: string) => {
      const set = sseClients.get(channel);
      if (!set) return;
      const parsed = JSON.parse(message) as { event?: string; data?: unknown };
      const event = parsed.event ?? 'message';
      const data = parsed.data !== undefined ? JSON.stringify(parsed.data) : message;
      const line = `event: ${event}\ndata: ${data}\n\n`;
      for (const res of set) {
        if (res.writableEnded) continue;
        try {
          res.write(line);
        } catch {
          /* ignore */
        }
      }
    });
  } catch (e) {
    log.warn({ message: 'Redis subscriber not started', error: (e as Error).message });
  }
}

export function getRedisSub(): Redis | null {
  return redisSub;
}

/** Close all SSE connections and the Redis subscriber. Call on process shutdown. */
export async function closeSseConnections(): Promise<void> {
  for (const [channel, set] of sseClients.entries()) {
    for (const res of set) {
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.delete(channel);
  }
  if (redisSub) {
    try {
      await redisSub.unsubscribe();
      await redisSub.quit();
    } catch {
      /* ignore */
    }
    redisSub = null;
  }
}

export function createSseRoute(log: Logger) {
  const sub = getRedisSub();
  return function sseRoute(req: Request, res: Response): void {
    const user = req.user;
    if (!user?.id || !sub) {
      res.status(503).json({ error: 'Events stream unavailable' });
      return;
    }
    const channel = `events:${user.id}`;
    let set = sseClients.get(channel);
    if (set && set.size >= SSE_MAX_CONNECTIONS_PER_USER) {
      res.status(429).json({ error: 'Too many event streams open. Close other tabs or wait and retry.' });
      return;
    }
    if (!set) {
      set = new Set();
      sseClients.set(channel, set);
    }
    set.add(res);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    sub.subscribe(channel).catch((err: Error) => {
      log.error({ message: 'SSE subscribe error', error: String(err) });
    });

    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      try {
        res.write(': heartbeat\n\n');
      } catch {
        /* ignore */
      }
    }, SSE_HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      const s = sseClients.get(channel);
      if (s) {
        s.delete(res);
        if (s.size === 0) {
          sseClients.delete(channel);
          sub.unsubscribe(channel).catch(() => {});
        }
      }
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* ignore */
      }
    });
  };
}
