import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/lib/stores/auth-store';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3004';

/** Same-origin URL for ws-token so cookies are sent; Next.js rewrites /api/* to gateway. */
const WS_TOKEN_URL = typeof window !== 'undefined' ? '/api/auth/ws-token' : '';

/** Delay before disconnecting on cleanup (avoids double connection in React Strict Mode) */
const DISCONNECT_DELAY_MS = 200;

async function fetchWsToken(): Promise<string | null> {
  if (!WS_TOKEN_URL) return null;
  try {
    const res = await fetch(WS_TOKEN_URL, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) {
      console.warn('[WebSocket] ws-token request failed:', res.status, res.statusText);
      return null;
    }
    const data = (await res.json()) as { token?: string };
    return data.token ?? null;
  } catch (e) {
    console.warn('[WebSocket] ws-token fetch error:', e);
    return null;
  }
}

export function useWebSocket() {
  const socketRef = useRef<Socket | null>(null);
  const connectingRef = useRef<boolean>(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuthStore();
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const disconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!user) {
      if (disconnectTimeoutRef.current) {
        clearTimeout(disconnectTimeoutRef.current);
        disconnectTimeoutRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
      }
      connectingRef.current = false;
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
      if (connectingRef.current) return;
      let cancelled = false;
      connectingRef.current = true;
      (async () => {
        const token = await fetchWsToken();
        if (cancelled) {
          connectingRef.current = false;
          return;
        }
        if (!token) {
          setError('Failed to get WebSocket token');
          connectingRef.current = false;
          return;
        }
        // No auto-reconnect: avoid dozens of failed attempts with same token; we reconnect manually with fresh token
        const newSocket = io(WS_URL, {
          auth: { token },
          withCredentials: true,
          transports: ['websocket', 'polling'],
          reconnection: false,
        });
        if (cancelled) {
          newSocket.disconnect();
          connectingRef.current = false;
          return;
        }
        socketRef.current = newSocket;
        connectingRef.current = false;
        const onConnect = () => {
          console.log('[WebSocket] Connected');
          setIsConnected(true);
          setError(null);
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
        };
        const onConnected = (data: unknown) => {
          console.log('[WebSocket] Connection confirmed:', data);
        };
        const onDisconnect = (reason: string) => {
          console.log('[WebSocket] Disconnected:', reason);
          setIsConnected(false);
          if (reason === 'io server disconnect') {
            reconnectTimeoutRef.current = setTimeout(async () => {
              const freshToken = await fetchWsToken();
              const current = socketRef.current;
              if (freshToken && current) {
                (current as Socket & { auth: Record<string, unknown> }).auth = { token: freshToken };
                current.connect();
              }
            }, 2000);
          }
        };
        const onConnectError = (err: Error) => {
          console.error('[WebSocket] Connection error:', err);
          setError(err.message);
          setIsConnected(false);
        };
        const onPing = () => {
          newSocket.emit('pong');
        };
        const onError = (data: { message: string }) => {
          console.error('[WebSocket] Error:', data);
          setError(data.message);
        };
        newSocket.on('connect', onConnect);
        newSocket.on('connected', onConnected);
        newSocket.on('disconnect', onDisconnect);
        newSocket.on('connect_error', onConnectError);
        newSocket.on('ping', onPing);
        newSocket.on('error', onError);
      })();
      return () => {
        cancelled = true;
        connectingRef.current = false;
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        disconnectTimeoutRef.current = setTimeout(() => {
          disconnectTimeoutRef.current = null;
          if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
          }
          setIsConnected(false);
        }, DISCONNECT_DELAY_MS);
      };
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

    const onConnected = (data: unknown) => {
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
  }, [user]);

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

  // При возврате на вкладку — переподключаемся с новым токеном, если сокет отвалился
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      const s = socketRef.current;
      if (!s || !user) return;
      if (s.connected) return;
      fetchWsToken().then((token) => {
        if (token && socketRef.current) {
          (socketRef.current as Socket & { auth: Record<string, unknown> }).auth = { token };
          socketRef.current.connect();
        }
      });
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [user]);

  // Периодическая попытка переподключения с новым токеном при длительном отключении
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      const s = socketRef.current;
      if (!s || s.connected || (s as Socket & { connecting?: boolean }).connecting) return;
      fetchWsToken().then((token) => {
        if (token && socketRef.current) {
          (socketRef.current as Socket & { auth: Record<string, unknown> }).auth = { token };
          socketRef.current.connect();
        }
      });
    }, 60000);
    return () => clearInterval(interval);
  }, [user]);

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

