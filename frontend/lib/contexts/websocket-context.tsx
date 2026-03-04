'use client';

import React, { createContext, useContext, useRef, useEffect } from 'react';
import { useWebSocket } from '@/lib/hooks/use-websocket';
import { getCurrentMessagingChat } from '@/lib/messaging-open-chat';
import { useNotificationsStore } from '@/lib/stores/notifications-store';

type WebSocketContextValue = ReturnType<typeof useWebSocket>;

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

import { playNotificationSound } from '@/lib/notification-sound';

const PLAY_SOUND_DEBOUNCE_MS = 2000;

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const value = useWebSocket();
  const lastSoundAt = useRef<number>(0);
  const { on, off, isConnected } = value;

  // Звук уведомления по всем новым сообщениям из аккаунтов пользователя (подписан на bd-account — только свои аккаунты), чтобы привлечь внимание
  useEffect(() => {
    const handler = (payload: { type?: string; data?: any }) => {
      if (payload?.type !== 'message.received') return;
      const data = payload.data;
      if (!data?.bdAccountId) return;

      // Не играть звук, если пользователь уже в этом чате (как в Telegram)
      const open = getCurrentMessagingChat();
      if (open && open.bdAccountId === data.bdAccountId && open.channelId === data.channelId) return;

      if (useNotificationsStore.getState().muted) return;

      const now = Date.now();
      if (now - lastSoundAt.current < PLAY_SOUND_DEBOUNCE_MS) return;
      lastSoundAt.current = now;

      playNotificationSound();
    };

    on('event', handler);
    return () => off('event', handler);
  }, [on, off, isConnected]);

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocketContext(): WebSocketContextValue {
  const ctx = useContext(WebSocketContext);
  if (!ctx) {
    throw new Error('useWebSocketContext must be used within WebSocketProvider');
  }
  return ctx;
}
