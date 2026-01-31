import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/lib/stores/auth-store';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3004';

/** Delay before disconnecting on cleanup (avoids double connection in React Strict Mode) */
const DISCONNECT_DELAY_MS = 200;

export function useWebSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { accessToken, user } = useAuthStore();
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const disconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!accessToken) {
      if (disconnectTimeoutRef.current) {
        clearTimeout(disconnectTimeoutRef.current);
        disconnectTimeoutRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
      }
      return;
    }

    // Cancel pending disconnect (React Strict Mode remounts immediately)
    if (disconnectTimeoutRef.current) {
      clearTimeout(disconnectTimeoutRef.current);
      disconnectTimeoutRef.current = null;
    }

    let socket = socketRef.current;
    const reuseSocket = socket && (socket.connected || (socket as Socket & { connecting?: boolean }).connecting);

    if (!reuseSocket) {
      socket = io(WS_URL, {
        auth: {
          token: accessToken,
        },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5,
      });
      socketRef.current = socket;
    } else {
      (socket as any).auth = { token: accessToken };
    }
    const s: Socket = socket as Socket;

    const onConnect = () => {
      console.log('[WebSocket] Connected');
      setIsConnected(true);
      setError(null);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    const onConnected = (data: any) => {
      console.log('[WebSocket] Connection confirmed:', data);
    };

    const onDisconnect = (reason: string) => {
      console.log('[WebSocket] Disconnected:', reason);
      setIsConnected(false);
      if (reason === 'io server disconnect') {
        reconnectTimeoutRef.current = setTimeout(() => {
          s.connect();
        }, 2000);
      }
    };

    const onConnectError = (err: Error) => {
      console.error('[WebSocket] Connection error:', err);
      setError(err.message);
      setIsConnected(false);
    };

    const onPing = () => {
      s.emit('pong');
    };

    const onError = (data: { message: string }) => {
      console.error('[WebSocket] Error:', data);
      setError(data.message);
    };

    if (reuseSocket) {
      s.off('connect');
      s.off('connected');
      s.off('disconnect');
      s.off('connect_error');
      s.off('ping');
      s.off('error');
      if (s.connected) {
        setIsConnected(true);
        setError(null);
      }
    }
    s.on('connect', onConnect);
    s.on('connected', onConnected);
    s.on('disconnect', onDisconnect);
    s.on('connect_error', onConnectError);
    s.on('ping', onPing);
    s.on('error', onError);

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      disconnectTimeoutRef.current = setTimeout(() => {
        disconnectTimeoutRef.current = null;
        s.disconnect();
      }, DISCONNECT_DELAY_MS);
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

