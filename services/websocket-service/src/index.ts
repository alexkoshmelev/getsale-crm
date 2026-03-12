import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType } from '@getsale/events';
import { UserRole } from '@getsale/types';

/** Auth service verify response shape */
interface AuthUserData {
  id: string;
  email: string;
  organization_id?: string;
  organizationId?: string;
  role: UserRole;
}

if (process.env.NODE_ENV === 'production' && (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN.trim() === '')) {
  throw new Error('CORS_ORIGIN must be set in production for WebSocket service.');
}
const wsCorsOrigin = process.env.CORS_ORIGIN || '*';

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3004;

const io = new Server(httpServer, {
  cors: {
    origin: wsCorsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Redis adapter for horizontal scaling
// Parse REDIS_URL if available, otherwise use individual settings
const redisUrl = process.env.REDIS_URL;
let redisConfig: any = {};

if (redisUrl) {
  // Parse redis://:password@host:port format
  try {
    const url = new URL(redisUrl);
    redisConfig = {
      host: url.hostname,
      port: parseInt(url.port || '6379'),
      password: url.password || undefined,
    };
  } catch (error) {
    console.error('Invalid REDIS_URL format, using defaults:', error);
    redisConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
    };
  }
} else {
  redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
  };
}

const pubClient = new Redis({
  ...redisConfig,
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

const subClient = pubClient.duplicate();

// Add error handlers to prevent warnings
pubClient.on('error', (error: Error) => {
  console.error('Redis pubClient error:', error);
});

pubClient.on('connect', () => {
  console.log('Redis pubClient connected');
});

subClient.on('error', (error: Error) => {
  console.error('Redis subClient error:', error);
});

subClient.on('connect', () => {
  console.log('Redis subClient connected');
});

io.adapter(createAdapter(pubClient, subClient));

// RabbitMQ for receiving events
const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

// Optional DB for room ownership verification (bd-account, chat)
const databaseUrl = process.env.DATABASE_URL;
const pool: Pool | null = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 4 })
  : null;

(async () => {
  try {
    await rabbitmq.connect();
    await subscribeToEvents();
  } catch (error) {
    console.error('Failed to connect to RabbitMQ, service will continue without event subscription:', error);
  }
})();

// Subscribe to events and broadcast via WebSocket
async function subscribeToEvents() {
  await rabbitmq.subscribeToEvents(
    [
      EventType.MESSAGE_RECEIVED,
      EventType.MESSAGE_SENT,
      EventType.MESSAGE_DELETED,
      EventType.MESSAGE_EDITED,
      EventType.DEAL_STAGE_CHANGED,
      EventType.AI_DRAFT_GENERATED,
      EventType.AI_DRAFT_APPROVED,
      EventType.BD_ACCOUNT_CONNECTED,
      EventType.BD_ACCOUNT_DISCONNECTED,
      EventType.BD_ACCOUNT_SYNC_STARTED,
      EventType.BD_ACCOUNT_SYNC_PROGRESS,
      EventType.BD_ACCOUNT_SYNC_COMPLETED,
      EventType.BD_ACCOUNT_SYNC_FAILED,
      EventType.BD_ACCOUNT_TELEGRAM_UPDATE,
      EventType.CONTACT_CREATED,
    ],
    async (event) => {
      try {
        // Broadcast to organization room (except message.received/sent и telegram_update — они только в bd-account)
        if (
          event.type !== EventType.MESSAGE_RECEIVED &&
          event.type !== EventType.MESSAGE_SENT &&
          event.type !== EventType.BD_ACCOUNT_TELEGRAM_UPDATE
        ) {
          io.to(`org:${event.organizationId}`).emit('event', {
            type: event.type,
            data: event.data,
            timestamp: event.timestamp,
          });
        }

        // Telegram presence: typing, user status, read receipt, draft — в комнату bd-account для Messaging
        if (event.type === EventType.BD_ACCOUNT_TELEGRAM_UPDATE) {
          const data = event.data as any;
          if (data?.bdAccountId) {
            io.to(`bd-account:${data.bdAccountId}`).emit('event', {
              type: event.type,
              data: event.data,
              timestamp: event.timestamp,
            });
          }
        }

        // Сообщения — только в комнаты bd-account и чата (подписчики аккаунта = те, кто отображает чаты этого аккаунта)
        if (event.type === EventType.MESSAGE_RECEIVED || event.type === EventType.MESSAGE_SENT) {
          const data = event.data as any;
          console.log(`[WebSocket] ${event.type} received, bdAccountId=${data?.bdAccountId}, channelId=${data?.channelId}`);
          if (data.contactId) {
            io.to(`chat:${data.contactId}`).emit('event', {
              type: event.type,
              data: event.data,
              timestamp: event.timestamp,
            });
          }
          if (data.bdAccountId) {
            io.to(`bd-account:${data.bdAccountId}`).emit('event', {
              type: event.type,
              data: event.data,
              timestamp: event.timestamp,
            });
            if (data.channelId) {
              const chatRoom = `bd-account:${data.bdAccountId}:chat:${data.channelId}`;
              io.to(chatRoom).emit('new-message', {
                message: data,
                timestamp: event.timestamp,
              });
              // Подписчики на аккаунт получают все новые сообщения (пуши по любому чату)
              io.to(`bd-account:${data.bdAccountId}`).emit('new-message', {
                message: data,
                timestamp: event.timestamp,
              });
            }
          }
        }

        // Удаление и редактирование сообщений — в комнату bd-account, чтобы Messaging обновлял список
        if (event.type === EventType.MESSAGE_DELETED || event.type === EventType.MESSAGE_EDITED) {
          const data = event.data as any;
          if (data?.bdAccountId) {
            io.to(`bd-account:${data.bdAccountId}`).emit('event', {
              type: event.type,
              data: event.data,
              timestamp: event.timestamp,
            });
          }
        }

        // Sync progress: broadcast to bd-account room for progress bar
        if (
          event.type === EventType.BD_ACCOUNT_SYNC_STARTED ||
          event.type === EventType.BD_ACCOUNT_SYNC_PROGRESS ||
          event.type === EventType.BD_ACCOUNT_SYNC_COMPLETED ||
          event.type === EventType.BD_ACCOUNT_SYNC_FAILED
        ) {
          const data = event.data as any;
          if (data?.bdAccountId) {
            io.to(`bd-account:${data.bdAccountId}`).emit('event', {
              type: event.type,
              data: event.data,
              timestamp: event.timestamp,
            });
          }
        }

        // Broadcast to specific user if userId is present
        if (event.userId) {
          io.to(`user:${event.userId}`).emit('event', {
            type: event.type,
            data: event.data,
            timestamp: event.timestamp,
          });
        }
      } catch (error) {
        console.error('[WebSocket] Error broadcasting event:', error);
      }
    },
    'events',
    'websocket-service'
  );
}

function getCookieFromHeader(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1].trim()) : undefined;
}

const ACCESS_TOKEN_COOKIE = 'access_token';
const REFRESH_TOKEN_COOKIE = 'refresh_token';

/** Parse access_token from Set-Cookie header(s) in auth refresh response. */
function getAccessTokenFromSetCookie(setCookieHeader: string | string[] | undefined): string | undefined {
  if (!setCookieHeader) return undefined;
  const parts = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const part of parts) {
    const match = part.match(new RegExp(`${ACCESS_TOKEN_COOKIE}=([^;]+)`));
    if (match) return decodeURIComponent(match[1].trim());
  }
  return undefined;
}

// Authentication middleware - verify token (from cookie, auth object, or Authorization header) with auth service
io.use(async (socket, next) => {
  try {
    let token =
      getCookieFromHeader(socket.handshake.headers.cookie, ACCESS_TOKEN_COOKIE) ||
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '')?.trim();

    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://auth-service:3001';
    const internalSecret = process.env.INTERNAL_AUTH_SECRET?.trim();

    const doVerify = async (t: string): Promise<{ ok: boolean; user?: AuthUserData; status?: number }> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (internalSecret) headers['x-internal-auth'] = internalSecret;
      const response = await fetch(`${authServiceUrl}/api/auth/verify`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ token: t }),
      });
      if (!response.ok) return { ok: false, status: response.status };
      const userData = (await response.json()) as AuthUserData;
      return { ok: true, user: userData };
    };

    try {
      let result = await doVerify(token);

      // On 401, try refresh_token from handshake cookie and retry verify
      if (!result.ok && result.status === 401) {
        const refreshToken = getCookieFromHeader(socket.handshake.headers.cookie, REFRESH_TOKEN_COOKIE);
        if (refreshToken) {
          const refreshHeaders: Record<string, string> = { Cookie: socket.handshake.headers.cookie || '' };
          if (internalSecret) refreshHeaders['x-internal-auth'] = internalSecret;
          const refreshRes = await fetch(`${authServiceUrl}/api/auth/refresh`, {
            method: 'POST',
            headers: refreshHeaders,
          });
          if (refreshRes.ok) {
            const headers = refreshRes.headers as Headers & { getSetCookie?: () => string[] };
            const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie'), headers.get('Set-Cookie')].filter(Boolean) as string[];
            const newAccess = getAccessTokenFromSetCookie(setCookies.length > 0 ? setCookies : undefined);
            if (newAccess) {
              result = await doVerify(newAccess);
            }
          }
        }
      }

      if (!result.ok || !result.user) {
        return next(new Error('Authentication error: Invalid token'));
      }

      const user = {
        id: result.user.id,
        email: result.user.email,
        organizationId: result.user.organization_id || result.user.organizationId,
        role: result.user.role,
      };

      (socket as any).user = user;
      next();
    } catch (error: any) {
      console.error('[WebSocket] Token verification error:', error);
      return next(new Error('Authentication error: Service unavailable'));
    }
  } catch (error: any) {
    console.error('[WebSocket] Authentication error:', error);
    next(new Error('Authentication error'));
  }
});

// Connection tracking for rate limiting
const connectionCounts = new Map<string, number>();
const connectionLimits = new Map<string, number>(); // per organization
const MAX_CONNECTIONS_PER_ORG = parseInt(process.env.MAX_CONNECTIONS_PER_ORG || '100');
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 100; // max events per window
const eventCounts = new Map<string, { count: number; resetAt: number }>();

// Heartbeat/ping mechanism (увеличен timeout, чтобы вкладка в фоне / тормоза не рвали соединение)
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 90000; // 90 seconds — ждём pong дольше при медленном клиенте или фоновой вкладке

io.on('connection', (socket) => {
  const user = (socket as any).user;

  if (!user || !user.id || !user.organizationId) {
    socket.disconnect();
    return;
  }

  // Check connection limits
  const orgConnections = connectionCounts.get(user.organizationId) || 0;
  if (orgConnections >= MAX_CONNECTIONS_PER_ORG) {
    console.warn(`[WebSocket] Connection limit reached for org ${user.organizationId}`);
    socket.emit('error', { message: 'Connection limit reached' });
    socket.disconnect();
    return;
  }

  // Increment connection count
  connectionCounts.set(user.organizationId, orgConnections + 1);
  connectionLimits.set(socket.id, orgConnections + 1);

  console.log(`[WebSocket] User ${user.id} (${user.email}) connected from org ${user.organizationId}`);

  // Join organization room
  socket.join(`org:${user.organizationId}`);

  // Join user-specific room
  socket.join(`user:${user.id}`);

  // Send connection confirmation
  socket.emit('connected', {
    userId: user.id,
    organizationId: user.organizationId,
    timestamp: new Date().toISOString(),
  });

  // Heartbeat mechanism
  let lastPing: number = Date.now();
  let heartbeatInterval: NodeJS.Timeout;
  let heartbeatTimeout: NodeJS.Timeout;

  const resetHeartbeat = () => {
    lastPing = Date.now();
    
    // Clear existing timeouts
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);

    // Set up ping interval
    heartbeatInterval = setInterval(() => {
      socket.emit('ping', { timestamp: Date.now() });
    }, HEARTBEAT_INTERVAL);

    // Set up timeout
    heartbeatTimeout = setTimeout(() => {
      console.log(`[WebSocket] Heartbeat timeout for user ${user.id}`);
      socket.disconnect();
    }, HEARTBEAT_TIMEOUT);
  };

  // Handle pong from client
  socket.on('pong', () => {
    resetHeartbeat();
  });

  // Start heartbeat
  resetHeartbeat();

  // Rate limiting for events
  const checkRateLimit = (): boolean => {
    const key = `${user.organizationId}:${socket.id}`;
    const now = Date.now();
    const limit = eventCounts.get(key);

    if (!limit || now > limit.resetAt) {
      eventCounts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
      return true;
    }

    if (limit.count >= RATE_LIMIT_MAX) {
      return false;
    }

    limit.count++;
    return true;
  };

  // Handle subscriptions with rate limiting and ownership verification (A6: cross-tenant leak prevention)
  socket.on('subscribe', async (room: string) => {
    if (!checkRateLimit()) {
      socket.emit('error', { message: 'Rate limit exceeded' });
      return;
    }

    if (typeof room !== 'string' || !room.trim()) {
      socket.emit('error', { message: 'Invalid room format' });
      return;
    }

    const trimmed = room.trim();

    // org: only own organization
    if (trimmed.startsWith('org:')) {
      const orgId = trimmed.slice(4);
      if (orgId !== user.organizationId) {
        socket.emit('error', { message: 'Invalid room access' });
        return;
      }
      socket.join(trimmed);
      socket.emit('subscribed', { room: trimmed });
      return;
    }

    // user: only own user room
    if (trimmed.startsWith('user:')) {
      const userId = trimmed.slice(5);
      if (userId !== user.id) {
        socket.emit('error', { message: 'Invalid room access' });
        return;
      }
      socket.join(trimmed);
      socket.emit('subscribed', { room: trimmed });
      return;
    }

    // bd-account: verify account belongs to user's organization
    if (trimmed.startsWith('bd-account:')) {
      const accountId = trimmed.slice(11);
      if (!accountId) {
        socket.emit('error', { message: 'Invalid room format' });
        return;
      }
      if (!pool) {
        socket.emit('error', { message: 'Room verification unavailable' });
        return;
      }
      try {
        const row = await pool.query(
          'SELECT organization_id FROM bd_accounts WHERE id = $1',
          [accountId]
        );
        if (row.rows.length === 0 || row.rows[0].organization_id !== user.organizationId) {
          socket.emit('error', { message: 'Invalid room access' });
          return;
        }
      } catch (err) {
        console.error('[WebSocket] Room ownership check failed:', err);
        socket.emit('error', { message: 'Room verification failed' });
        return;
      }
      socket.join(trimmed);
      socket.emit('subscribed', { room: trimmed });
      return;
    }

    // chat: allow only with same ownership check via bd_account (conversations.bd_account_id -> bd_accounts.organization_id)
    if (trimmed.startsWith('chat:')) {
      if (!pool) {
        socket.emit('error', { message: 'Room verification unavailable' });
        return;
      }
      const conversationId = trimmed.slice(5);
      if (!conversationId) {
        socket.emit('error', { message: 'Invalid room format' });
        return;
      }
      try {
        const row = await pool.query(
          `SELECT ba.organization_id FROM conversations c
           JOIN bd_accounts ba ON ba.id = c.bd_account_id
           WHERE c.id = $1`,
          [conversationId]
        );
        if (row.rows.length === 0 || row.rows[0].organization_id !== user.organizationId) {
          socket.emit('error', { message: 'Invalid room access' });
          return;
        }
      } catch (err) {
        console.error('[WebSocket] Chat room ownership check failed:', err);
        socket.emit('error', { message: 'Room verification failed' });
        return;
      }
      socket.join(trimmed);
      socket.emit('subscribed', { room: trimmed });
      return;
    }

    socket.emit('error', { message: 'Invalid room format' });
  });

  socket.on('unsubscribe', (room: string) => {
    if (typeof room !== 'string') {
      return;
    }
    socket.leave(room);
    socket.emit('unsubscribed', { room });
  });

  // Handle custom events with rate limiting
  socket.onAny((eventName, ...args) => {
    if (eventName === 'subscribe' || eventName === 'unsubscribe' || eventName === 'pong') {
      return; // Already handled
    }

    if (!checkRateLimit()) {
      socket.emit('error', { message: 'Rate limit exceeded' });
      return;
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[WebSocket] User ${user.id} disconnected: ${reason}`);

    // Cleanup heartbeat
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);

    // Decrement connection count
    const current = connectionCounts.get(user.organizationId) || 0;
    connectionCounts.set(user.organizationId, Math.max(0, current - 1));
    connectionLimits.delete(socket.id);
    eventCounts.delete(`${user.organizationId}:${socket.id}`);
  });
});

app.get('/health', (req, res) => {
  const totalConnections = Array.from(connectionCounts.values()).reduce((a, b) => a + b, 0);
  res.json({ 
    status: 'ok', 
    service: 'websocket-service',
    connections: {
      total: totalConnections,
      byOrganization: Object.fromEntries(connectionCounts),
    },
  });
});

httpServer.listen(PORT, () => {
  console.log(`WebSocket service running on port ${PORT}`);
});

