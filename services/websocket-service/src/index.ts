import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'ioredis';
import fetch from 'node-fetch';
import { RabbitMQClient } from '@getsale/utils';
import { EventType } from '@getsale/events';

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3004;

const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
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

const pubClient = createClient({
  ...redisConfig,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

const subClient = pubClient.duplicate();

// Add error handlers to prevent warnings
pubClient.on('error', (error) => {
  console.error('Redis pubClient error:', error);
});

pubClient.on('connect', () => {
  console.log('Redis pubClient connected');
});

subClient.on('error', (error) => {
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
      EventType.DEAL_STAGE_CHANGED,
      EventType.AI_DRAFT_GENERATED,
      EventType.AI_DRAFT_APPROVED,
      EventType.BD_ACCOUNT_CONNECTED,
      EventType.BD_ACCOUNT_DISCONNECTED,
      EventType.BD_ACCOUNT_SYNC_STARTED,
      EventType.BD_ACCOUNT_SYNC_PROGRESS,
      EventType.BD_ACCOUNT_SYNC_COMPLETED,
      EventType.BD_ACCOUNT_SYNC_FAILED,
      EventType.CONTACT_CREATED,
    ],
    async (event) => {
      try {
        // Broadcast to organization room
        io.to(`org:${event.organizationId}`).emit('event', {
          type: event.type,
          data: event.data,
          timestamp: event.timestamp,
        });

        // Also broadcast to specific rooms based on event type
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
              const room = `bd-account:${data.bdAccountId}:chat:${data.channelId}`;
              io.to(room).emit('new-message', {
                message: data,
                timestamp: event.timestamp,
              });
              console.log(`[WebSocket] new-message emitted to room ${room}`);
            }
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

// Authentication middleware - verify token with auth service
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    // Verify token with auth service
    const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://auth-service:3001';
    
    try {
      const response = await fetch(`${authServiceUrl}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (!response.ok) {
        return next(new Error('Authentication error: Invalid token'));
      }

      const userData = await response.json();
      const user = {
        id: userData.id,
        email: userData.email,
        organizationId: userData.organization_id || userData.organizationId,
        role: userData.role,
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

// Heartbeat/ping mechanism
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 60000; // 60 seconds

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

  // Handle subscriptions with rate limiting
  socket.on('subscribe', (room: string) => {
    if (!checkRateLimit()) {
      socket.emit('error', { message: 'Rate limit exceeded' });
      return;
    }

    if (typeof room !== 'string') {
      socket.emit('error', { message: 'Invalid room format' });
      return;
    }

    // Validate room format (security)
    const validRoomPatterns = [
      `org:${user.organizationId}`,
      `user:${user.id}`,
      `bd-account:`,
      `chat:`,
    ];

    const isValid = validRoomPatterns.some(pattern => room.startsWith(pattern));
    if (!isValid && !room.startsWith(`org:${user.organizationId}`)) {
      socket.emit('error', { message: 'Invalid room access' });
      return;
    }

    socket.join(room);
    socket.emit('subscribed', { room });
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

