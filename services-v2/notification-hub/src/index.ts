import Fastify from 'fastify';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { createLogger } from '@getsale/logger';
import { RabbitMQClient } from '@getsale/queue';
import { EventType } from '@getsale/events';

const log = createLogger('notification-hub-v2');
const PORT = parseInt(process.env.PORT || '4008', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672';

const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : [process.env.FRONTEND_ORIGIN || 'http://localhost:3000'];

const HEARTBEAT_INTERVAL = 25_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** Per socket, per process. With multiple hub replicas, each instance enforces its own window (no global cap). */
const RATE_LIMIT_MAX_EVENTS = 80;
const ALLOWED_ROOM_PREFIXES = ['org:', 'user:', 'bd-account:', 'chat:'];
/**
 * Per-process org connection cap. Behind a load balancer with N replicas, effective org-wide capacity is roughly
 * N × this value (each replica tracks only its own sockets). This default is intentionally conservative so the
 * aggregate stays reasonable when scaling horizontally. For strict global enforcement across replicas, use
 * Redis-backed counters (INCR/EXPIRE or a small Lua script) keyed by organization id, or sticky sessions plus ops tuning.
 */
const MAX_CONNECTIONS_PER_ORG = 30;
const HEARTBEAT_TIMEOUT_MS = 90_000;

// In-memory only: limits are per Node process. Multiple replicas each apply their own caps (see MAX_CONNECTIONS_PER_ORG).
// For strict global limits, mirror counts in Redis. rateLimits: per socket id on this instance; orgConnectionCounts: per org on this instance.
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const orgConnectionCounts = new Map<string, number>();

function checkRateLimit(socketId: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(socketId);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(socketId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_EVENTS) return false;
  entry.count++;
  return true;
}

async function main() {
  const app = Fastify({ logger: false });
  const httpServer = app.server;

  const pubClient = new Redis(REDIS_URL);
  const subClient = pubClient.duplicate();

  const io = new Server(httpServer, {
    cors: { origin: CORS_ORIGIN, credentials: true },
    adapter: createAdapter(pubClient, subClient),
    pingTimeout: 30_000,
    pingInterval: 15_000,
  });

  // Redis bridge: forward user-targeted events from Redis pub/sub to Socket.IO
  const bridgeSubscriber = new Redis(REDIS_URL);
  bridgeSubscriber.on('error', (err: Error) => log.error({ message: 'Redis bridge error', error: String(err) }));
  bridgeSubscriber.psubscribe('events:*').catch((err: Error) => {
    log.error({ message: 'Failed to psubscribe to events:*', error: String(err) });
  });
  bridgeSubscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
    const userId = channel.replace(/^events:/, '');
    if (!userId) return;
    try {
      const parsed = JSON.parse(message) as { event?: string; data?: unknown };
      io.to(`user:${userId}`).emit('event', {
        type: parsed.event ?? 'message',
        data: parsed.data ?? parsed,
        timestamp: new Date().toISOString(),
      });
    } catch {
      log.warn({ message: 'Redis bridge: failed to parse message', channel });
    }
  });

  const heartbeatIntervals: NodeJS.Timeout[] = [];

  // JWT authentication — supports auth.token, Authorization header, and cookie
  const ACCESS_TOKEN_COOKIE = (process.env.AUTH_COOKIE_ACCESS || 'access_token').trim() || 'access_token';
  io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    let cookieToken: string | undefined;
    if (cookieHeader) {
      const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${ACCESS_TOKEN_COOKIE}=([^;]*)`));
      cookieToken = match ? decodeURIComponent(match[1].trim()) : undefined;
    }
    const token =
      cookieToken ||
      (socket.handshake.auth?.token as string | undefined) ||
      socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '').trim() ||
      undefined;
    if (!token) return next(new Error('Authentication required'));
    try {
      const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as {
        userId: string; organizationId?: string; organization_id?: string; role: string;
      };
      const organizationId = payload.organizationId || payload.organization_id;
      if (!payload.userId || !organizationId) return next(new Error('Invalid token payload'));
      socket.data.userId = payload.userId;
      socket.data.organizationId = organizationId;
      socket.data.role = payload.role;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, organizationId } = socket.data;

    const currentCount = orgConnectionCounts.get(organizationId) || 0;
    if (currentCount >= MAX_CONNECTIONS_PER_ORG) {
      log.warn({ message: 'Org connection limit reached', organization_id: organizationId, limit: MAX_CONNECTIONS_PER_ORG });
      socket.emit('error', { message: 'Too many connections for your workspace' });
      socket.disconnect(true);
      return;
    }
    orgConnectionCounts.set(organizationId, currentCount + 1);

    socket.join(`org:${organizationId}`);
    socket.join(`user:${userId}`);

    log.info({ message: 'Socket connected', user_id: userId, organization_id: organizationId, socket_id: socket.id });

    socket.emit('connected', { userId, organizationId, timestamp: new Date().toISOString() });

    // Heartbeat: server pings, client responds with pong
    const pingInterval = setInterval(() => {
      socket.emit('ping', { timestamp: Date.now() });
    }, HEARTBEAT_INTERVAL);
    heartbeatIntervals.push(pingInterval);

    let lastPong = Date.now();
    socket.on('pong', () => { lastPong = Date.now(); });

    const heartbeatCheck = setInterval(() => {
      if (Date.now() - lastPong > HEARTBEAT_TIMEOUT_MS) {
        log.warn({ message: 'Heartbeat timeout, disconnecting', user_id: userId, socket_id: socket.id });
        clearInterval(heartbeatCheck);
        socket.disconnect(true);
      }
    }, HEARTBEAT_TIMEOUT_MS / 2);

    // Room subscribe/unsubscribe
    socket.on('subscribe', async (room: string) => {
      if (typeof room !== 'string') return;
      if (!ALLOWED_ROOM_PREFIXES.some((p) => room.startsWith(p))) return;

      if (room.startsWith('bd-account:') || room.startsWith('chat:')) {
        if (!socket.data.organizationId) {
          socket.emit('error', { message: 'Not authorized for this room' });
          return;
        }
      }

      socket.join(room);
      socket.emit('subscribed', { room });
    });

    socket.on('unsubscribe', (room: string) => {
      if (typeof room === 'string' && room !== `org:${organizationId}` && room !== `user:${userId}`) {
        socket.leave(room);
        socket.emit('unsubscribed', { room });
      }
    });

    socket.on('rejoin-rooms', (rooms: unknown) => {
      if (!Array.isArray(rooms)) return;
      const joined: string[] = [];
      for (const room of rooms) {
        if (typeof room === 'string' && ALLOWED_ROOM_PREFIXES.some((p) => room.startsWith(p))) {
          socket.join(room);
          joined.push(room);
        }
      }
      if (joined.length > 0) {
        socket.emit('rooms-rejoined', { rooms: joined });
        log.info({ message: 'Rooms rejoined after reconnect', user_id: userId, room_count: joined.length, socket_id: socket.id });
      }
    });

    // Rate limiting — exempt pong, subscribe, unsubscribe
    socket.onAny((eventName: string) => {
      if (eventName === 'subscribe' || eventName === 'unsubscribe' || eventName === 'pong') return;
      if (!checkRateLimit(socket.id)) {
        socket.emit('error', { message: 'Rate limit exceeded' });
      }
    });

    socket.on('disconnect', (reason) => {
      clearInterval(pingInterval);
      clearInterval(heartbeatCheck);
      const idx = heartbeatIntervals.indexOf(pingInterval);
      if (idx !== -1) heartbeatIntervals.splice(idx, 1);
      rateLimits.delete(socket.id);
      const count = orgConnectionCounts.get(organizationId) || 0;
      if (count > 0) orgConnectionCounts.set(organizationId, count - 1);
      log.info({ message: 'Socket disconnected', user_id: userId, reason, socket_id: socket.id });
    });
  });

  // ── RabbitMQ event broadcasting ────────────────────────────────────
  const rabbitmq = new RabbitMQClient({ url: RABBITMQ_URL, log });
  await rabbitmq.connect();

  const BROADCAST_EVENTS = [
    EventType.MESSAGE_RECEIVED,
    EventType.MESSAGE_SENT,
    EventType.MESSAGE_READ,
    EventType.MESSAGE_DELETED,
    EventType.MESSAGE_EDITED,
    EventType.CONTACT_CREATED,
    EventType.CONTACT_UPDATED,
    EventType.DEAL_CREATED,
    EventType.DEAL_UPDATED,
    EventType.DEAL_STAGE_CHANGED,
    EventType.LEAD_CREATED,
    EventType.LEAD_STAGE_CHANGED,
    EventType.CAMPAIGN_STARTED,
    EventType.CAMPAIGN_COMPLETED,
    EventType.CAMPAIGN_PAUSED,
    EventType.BD_ACCOUNT_CONNECTED,
    EventType.BD_ACCOUNT_DISCONNECTED,
    EventType.BD_ACCOUNT_SYNC_STARTED,
    EventType.BD_ACCOUNT_SYNC_PROGRESS,
    EventType.BD_ACCOUNT_SYNC_COMPLETED,
    EventType.BD_ACCOUNT_SYNC_FAILED,
    EventType.BD_ACCOUNT_TELEGRAM_UPDATE,
    EventType.AI_DRAFT_GENERATED,
    EventType.AI_DRAFT_APPROVED,
    EventType.DISCOVERY_TASK_STARTED,
  ];

  await rabbitmq.subscribeToEvents(
    BROADCAST_EVENTS,
    async (event) => {
      try {
        const orgId = event.organizationId;
        const data = event.data as Record<string, unknown> | undefined;
        const eventPayload = { type: event.type, data: event.data, timestamp: event.timestamp };

        // Org-level broadcast — skip message & telegram events (they target specific rooms)
        if (
          orgId &&
          event.type !== EventType.MESSAGE_RECEIVED &&
          event.type !== EventType.MESSAGE_SENT &&
          event.type !== EventType.BD_ACCOUNT_TELEGRAM_UPDATE
        ) {
          io.to(`org:${orgId}`).emit('event', eventPayload);
        }

        // Telegram updates → bd-account room
        if (event.type === EventType.BD_ACCOUNT_TELEGRAM_UPDATE && data?.bdAccountId) {
          io.to(`bd-account:${data.bdAccountId}`).emit('event', eventPayload);
        }

        // Message received/sent → contact chat room + bd-account room + new-message
        if (event.type === EventType.MESSAGE_RECEIVED || event.type === EventType.MESSAGE_SENT) {
          if (data?.contactId) {
            io.to(`chat:${data.contactId}`).emit('event', eventPayload);
          }
          if (data?.bdAccountId) {
            io.to(`bd-account:${data.bdAccountId}`).emit('event', eventPayload);
            if (data.channelId) {
              const newMsgPayload = { message: data, timestamp: event.timestamp };
              io.to(`bd-account:${data.bdAccountId}:chat:${data.channelId}`).emit('new-message', newMsgPayload);
              io.to(`bd-account:${data.bdAccountId}`).emit('new-message', newMsgPayload);
            }
          }
        }

        // Message edit/delete → bd-account room
        if (
          (event.type === EventType.MESSAGE_DELETED || event.type === EventType.MESSAGE_EDITED) &&
          data?.bdAccountId
        ) {
          io.to(`bd-account:${data.bdAccountId}`).emit('event', eventPayload);
        }

        // Sync progress events → bd-account room
        if (
          (event.type === EventType.BD_ACCOUNT_SYNC_STARTED ||
            event.type === EventType.BD_ACCOUNT_SYNC_PROGRESS ||
            event.type === EventType.BD_ACCOUNT_SYNC_COMPLETED ||
            event.type === EventType.BD_ACCOUNT_SYNC_FAILED) &&
          data?.bdAccountId
        ) {
          io.to(`bd-account:${data.bdAccountId}`).emit('event', eventPayload);
        }

        // User-targeted events
        if (event.userId) {
          io.to(`user:${event.userId}`).emit('event', eventPayload);
        }
      } catch (error) {
        log.error({ message: 'Error broadcasting event', error: String(error) });
      }
    },
    'events',
    'notification-hub-v2.broadcast',
  );

  app.get('/health', async () => ({
    status: 'ok',
    service: 'notification-hub-v2',
    connections: io.engine.clientsCount,
  }));

  await app.listen({ port: PORT, host: '0.0.0.0' });
  log.info({ message: `Notification Hub running on port ${PORT}` });

  const shutdown = async () => {
    log.info({ message: 'Notification Hub shutting down' });
    heartbeatIntervals.forEach((interval) => clearInterval(interval));
    heartbeatIntervals.length = 0;
    io.close();
    await rabbitmq.close();
    bridgeSubscriber.disconnect();
    pubClient.disconnect();
    subClient.disconnect();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error({ message: 'Notification Hub failed to start', error: String(err) });
  process.exit(1);
});
