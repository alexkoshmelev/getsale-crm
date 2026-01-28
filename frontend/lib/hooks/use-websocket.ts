import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/lib/stores/auth-store';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3004';

export function useWebSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { accessToken, user } = useAuthStore();
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!accessToken) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
      }
      return;
    }

    const socket = io(WS_URL, {
      auth: {
        token: accessToken,
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    });

    socket.on('connect', () => {
      console.log('[WebSocket] Connected');
      setIsConnected(true);
      setError(null);
      
      // Clear any reconnect timeout
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    });

    socket.on('connected', (data: any) => {
      console.log('[WebSocket] Connection confirmed:', data);
    });

    socket.on('disconnect', (reason: string) => {
      console.log('[WebSocket] Disconnected:', reason);
      setIsConnected(false);
      
      // Attempt reconnect if not intentional
      if (reason === 'io server disconnect') {
        // Server disconnected, try to reconnect
        reconnectTimeoutRef.current = setTimeout(() => {
          socket.connect();
        }, 2000);
      }
    });

    socket.on('connect_error', (err: Error) => {
      console.error('[WebSocket] Connection error:', err);
      setError(err.message);
      setIsConnected(false);
    });

    // Handle ping/pong for heartbeat
    socket.on('ping', (data: { timestamp: number }) => {
      socket.emit('pong');
    });

    socket.on('error', (data: { message: string }) => {
      console.error('[WebSocket] Error:', data);
      setError(data.message);
    });

    socketRef.current = socket;

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      socket.disconnect();
    };
  }, [accessToken]);

  const subscribe = useCallback((room: string) => {
    if (socketRef.current && isConnected) {
      socketRef.current.emit('subscribe', room);
      console.log('[WebSocket] Subscribed to:', room);
    }
  }, [isConnected]);

  const unsubscribe = useCallback((room: string) => {
    if (socketRef.current && isConnected) {
      socketRef.current.emit('unsubscribe', room);
      console.log('[WebSocket] Unsubscribed from:', room);
    }
  }, [isConnected]);

  const on = useCallback((event: string, callback: (data: any) => void) => {
    if (socketRef.current) {
      socketRef.current.on(event, callback);
    }
  }, []);

  const off = useCallback((event: string, callback?: (data: any) => void) => {
    if (socketRef.current) {
      socketRef.current.off(event, callback);
    }
  }, []);

  const emit = useCallback((event: string, data?: any) => {
    if (socketRef.current && isConnected) {
      socketRef.current.emit(event, data);
    }
  }, [isConnected]);

  // Auto-subscribe to organization room when connected
  useEffect(() => {
    if (isConnected && user?.organizationId) {
      subscribe(`org:${user.organizationId}`);
      subscribe(`user:${user.id}`);
    }
  }, [isConnected, user?.organizationId, user?.id, subscribe]);

  return {
    isConnected,
    error,
    subscribe,
    unsubscribe,
    on,
    off,
    emit,
  };
}

