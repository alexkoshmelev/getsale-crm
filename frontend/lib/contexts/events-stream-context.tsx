'use client';

import React, { createContext, useContext, useRef, useEffect, useCallback, useState } from 'react';

type EventHandler = (data: Record<string, unknown>) => void;

interface EventsStreamContextValue {
  subscribe: (eventType: string, handler: EventHandler) => () => void;
  isConnected: boolean;
}

const EventsStreamContext = createContext<EventsStreamContextValue | null>(null);

const STREAM_URL = typeof window !== 'undefined'
  ? `${window.location.origin}/api/events/stream`
  : '';

export function EventsStreamProvider({ children }: { children: React.ReactNode }) {
  const handlersRef = useRef<Map<string, Set<EventHandler>>>(new Map());
  const [isConnected, setConnected] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);

  const connect = useCallback(() => {
    if (typeof window === 'undefined' || !STREAM_URL) return;
    abortRef.current = new AbortController();
    const ac = abortRef.current;

    fetch(STREAM_URL, { credentials: 'include', signal: ac.signal })
      .then((res) => {
        if (!res.ok || !res.body) {
          setConnected(false);
          return;
        }
        setConnected(true);
        reconnectDelayRef.current = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let currentEvent = 'message';

        const pump = async (): Promise<void> => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              setConnected(false);
              return;
            }
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim();
                continue;
              }
              if (line.startsWith('data:')) {
                const raw = line.slice(5).trim();
                if (raw === '[DONE]' || raw === '') continue;
                try {
                  const data = JSON.parse(raw) as Record<string, unknown>;
                  const set = handlersRef.current.get(currentEvent);
                  if (set) {
                    set.forEach((h) => {
                      try {
                        h(data);
                      } catch (_) {}
                    });
                  }
                  const all = handlersRef.current.get('*');
                  if (all) {
                    all.forEach((h) => {
                      try {
                        h({ ...data, _event: currentEvent });
                      } catch (_) {}
                    });
                  }
                } catch (_) {}
                currentEvent = 'message';
              }
            }
            return pump();
          } catch (e) {
            if ((e as Error)?.name === 'AbortError') return;
            setConnected(false);
            const delay = reconnectDelayRef.current;
            reconnectDelayRef.current = Math.min(delay * 2, 30000);
            reconnectTimeoutRef.current = setTimeout(connect, delay);
          }
        };
        return pump();
      })
      .catch(() => {
        setConnected(false);
        const delay = reconnectDelayRef.current;
        reconnectDelayRef.current = Math.min(delay * 2, 30000);
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      });
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [connect]);

  const subscribe = useCallback((eventType: string, handler: EventHandler) => {
    let set = handlersRef.current.get(eventType);
    if (!set) {
      set = new Set();
      handlersRef.current.set(eventType, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set?.size === 0) handlersRef.current.delete(eventType);
    };
  }, []);

  const value: EventsStreamContextValue = { subscribe, isConnected };

  return (
    <EventsStreamContext.Provider value={value}>
      {children}
    </EventsStreamContext.Provider>
  );
}

export function useEventsStream(): EventsStreamContextValue {
  const ctx = useContext(EventsStreamContext);
  if (!ctx) {
    return {
      subscribe: () => () => {},
      isConnected: false,
    };
  }
  return ctx;
}
