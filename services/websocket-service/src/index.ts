import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { createServiceApp } from '@getsale/service-core';
import { createSocketAuth, type SocketUser } from './socket-auth';
import { ConnectionTracker } from './connection-tracker';
import { registerRoomHandlers } from './room-handlers';
import { subscribeToEvents } from './event-broadcaster';
import { startRedisBridge } from './redis-bridge';

(async () => {
  const { app, pool, rabbitmq, log } = await createServiceApp({
    name: 'websocket-service',
    port: parseInt(process.env.PORT || '3004', 10),
    skipDb: !process.env.DATABASE_URL,
    skipUserExtract: true,
    cors: true,
    poolConfig: { max: 4 },
    onShutdown: async () => {
      io.close();
      pubClient.disconnect();
      subClient.disconnect();
      bridgeSubscriber.disconnect();
    },
  });

  const httpServer = createServer(app);

  const wsCorsOrigin = process.env.CORS_ORIGIN || '*';
  if (process.env.NODE_ENV === 'production' && (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN.trim() === '')) {
    throw new Error('CORS_ORIGIN must be set in production for WebSocket service.');
  }

  const io = new Server(httpServer, {
    cors: {
      origin: wsCorsOrigin,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Redis adapter for horizontal scaling
  const redisUrl = process.env.REDIS_URL;
  let redisConfig: Record<string, any> = {};
  if (redisUrl) {
    try {
      const url = new URL(redisUrl);
      redisConfig = {
        host: url.hostname,
        port: parseInt(url.port || '6380'),
        password: url.password || undefined,
      };
    } catch {
      log.warn({ message: 'Invalid REDIS_URL format, using defaults' });
      redisConfig = {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6380'),
        password: process.env.REDIS_PASSWORD,
      };
    }
  } else {
    redisConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6380'),
      password: process.env.REDIS_PASSWORD,
    };
  }

  const pubClient = new Redis({
    ...redisConfig,
    retryStrategy: (times: number) => Math.min(times * 50, 2000),
    maxRetriesPerRequest: 3,
  });
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err: Error) => log.error({ message: 'Redis pubClient error', error: String(err) }));
  pubClient.on('connect', () => log.info({ message: 'Redis pubClient connected' }));
  subClient.on('error', (err: Error) => log.error({ message: 'Redis subClient error', error: String(err) }));
  subClient.on('connect', () => log.info({ message: 'Redis subClient connected' }));

  io.adapter(createAdapter(pubClient, subClient));

  const bridgeSubscriber = startRedisBridge(io, redisConfig, log);

  // Auth middleware — local JWT verification
  io.use(createSocketAuth(log));

  // Connection tracking
  const tracker = new ConnectionTracker(log);
  const dbPool = process.env.DATABASE_URL ? pool : null;

  io.on('connection', (socket) => {
    const user = (socket as any).user as SocketUser;
    if (!user?.id || !user?.organizationId) {
      socket.disconnect();
      return;
    }

    if (!tracker.canConnect(user.organizationId)) {
      socket.emit('error', { message: 'Connection limit reached' });
      socket.disconnect();
      return;
    }

    tracker.trackConnect(user.organizationId);
    log.info({ message: 'User connected', user_id: user.id, organization_id: user.organizationId, socket_id: socket.id });

    socket.join(`org:${user.organizationId}`);
    socket.join(`user:${user.id}`);

    socket.emit('connected', {
      userId: user.id,
      organizationId: user.organizationId,
      timestamp: new Date().toISOString(),
    });

    const cleanupHeartbeat = tracker.setupHeartbeat(socket, user);

    registerRoomHandlers(socket, user, { pool: dbPool, log, tracker });

    socket.onAny((eventName) => {
      if (eventName === 'subscribe' || eventName === 'unsubscribe' || eventName === 'pong') return;
      if (!tracker.checkRateLimit(user.organizationId, socket.id)) {
        socket.emit('error', { message: 'Rate limit exceeded' });
      }
    });

    socket.on('disconnect', (reason) => {
      log.info({ message: 'User disconnected', user_id: user.id, reason, socket_id: socket.id });
      cleanupHeartbeat();
      tracker.trackDisconnect(user.organizationId, socket.id);
    });
  });

  // RabbitMQ event broadcasting
  try {
    await subscribeToEvents(io, rabbitmq, log);
  } catch (error) {
    log.warn({ message: 'Failed to subscribe to RabbitMQ events, continuing without event broadcasting', error: String(error) });
  }

  // Health endpoint (override the default one from createServiceApp to include WS connection count)
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'websocket-service',
      connections: { total: tracker.getTotalConnections() },
    });
  });

  httpServer.listen(parseInt(process.env.PORT || '3004', 10), () => {
    log.info({ message: `websocket-service running on port ${process.env.PORT || 3004}` });
  });

  const shutdown = async (signal: string) => {
    log.info({ message: `websocket-service received ${signal}, shutting down` });
    io.close();
    pubClient.disconnect();
    subClient.disconnect();
    bridgeSubscriber.disconnect();
    httpServer.close();
    if (dbPool) await pool.end();
    await rabbitmq.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();
