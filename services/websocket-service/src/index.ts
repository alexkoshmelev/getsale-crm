import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'ioredis';
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
const pubClient = createClient({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});
const subClient = pubClient.duplicate();

io.adapter(createAdapter(pubClient, subClient));

// RabbitMQ for receiving events
const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

(async () => {
  await rabbitmq.connect();
  await subscribeToEvents();
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
    ],
    async (event) => {
      // Broadcast to organization room
      io.to(`org:${event.organizationId}`).emit('event', {
        type: event.type,
        data: event.data,
        timestamp: event.timestamp,
      });
    },
    'events',
    'websocket-service'
  );
}

// Authentication middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    // Verify token (simplified - should call auth service)
    // In production, verify with auth service
    const user = { id: 'user-id', organizationId: 'org-id' }; // TODO: Verify token

    (socket as any).user = user;
    next();
  } catch (error) {
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  const user = (socket as any).user;

  console.log(`User ${user.id} connected`);

  // Join organization room
  socket.join(`org:${user.organizationId}`);

  // Join user-specific room
  socket.join(`user:${user.id}`);

  // Handle subscriptions
  socket.on('subscribe', (room: string) => {
    socket.join(room);
  });

  socket.on('unsubscribe', (room: string) => {
    socket.leave(room);
  });

  socket.on('disconnect', () => {
    console.log(`User ${user.id} disconnected`);
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'websocket-service' });
});

httpServer.listen(PORT, () => {
  console.log(`WebSocket service running on port ${PORT}`);
});

