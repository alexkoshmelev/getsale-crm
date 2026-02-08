'use client';

import React, { createContext, useContext, useRef, useEffect } from 'react';
import { useWebSocket } from '@/lib/hooks/use-websocket';
import { getCurrentMessagingChat } from '@/lib/messaging-open-chat';
import { useNotificationsStore } from '@/lib/stores/notifications-store';

type WebSocketContextValue = ReturnType<typeof useWebSocket>;

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

const NOTIFICATION_SOUND_PATH = '/notification.mp3';
const PLAY_SOUND_DEBOUNCE_MS = 2000;

/** Короткий звук уведомления как в Telegram (Web Audio API — работает без файла) */
function playBeepNotification(): void {
  if (typeof window === 'undefined') return;
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 800;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
  } catch (_) {}
}

/** Воспроизвести звук нового сообщения: сначала MP3 (если есть), иначе короткий «динг» */
function playNotificationSound(): void {
  if (typeof window === 'undefined') return;
  const audio = new Audio(NOTIFICATION_SOUND_PATH);
  audio.volume = 0.6;
  audio.play().then(() => {}).catch(() => {
    playBeepNotification();
  });
  // Если файл не загрузится (404), fallback по событию error
  audio.addEventListener('error', () => playBeepNotification(), { once: true });
}

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
