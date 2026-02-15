'use client';

import { useState, useEffect, useRef } from 'react';
import { apiClient } from '@/lib/api/client';
import { blobUrlCache, avatarChatKey } from '@/lib/cache/blob-url-cache';

/** Аватар чата для карточки сделки (если сделка привязана к чату по bd_account_id + channel_id). */
export function DealChatAvatar({
  bdAccountId,
  channelId,
  title,
  className = 'w-10 h-10',
}: {
  bdAccountId: string;
  channelId: string;
  title?: string | null;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const mounted = useRef(true);
  const key = avatarChatKey(bdAccountId, channelId);

  useEffect(() => {
    if (!bdAccountId || !channelId) return;
    mounted.current = true;
    const cached = blobUrlCache.get(key);
    if (cached) {
      setSrc(cached);
      return () => {
        mounted.current = false;
        setSrc(null);
      };
    }
    apiClient
      .get(`/api/bd-accounts/${bdAccountId}/chats/${channelId}/avatar`, { responseType: 'blob' })
      .then((res) => {
        if (mounted.current && res.data instanceof Blob && res.data.size > 0) {
          const u = URL.createObjectURL(res.data);
          blobUrlCache.set(key, u);
          setSrc(u);
        }
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      setSrc(null);
    };
  }, [bdAccountId, channelId, key]);

  const initials = title
    ? title
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 2) || '?'
    : '?';

  return (
    <div
      className={`rounded-full flex items-center justify-center overflow-hidden bg-muted text-muted-foreground shrink-0 ${className}`}
      title={title ?? undefined}
    >
      {src ? (
        <img src={src} alt={title ?? ''} className="w-full h-full object-cover" />
      ) : (
        <span className="text-[0.55em] font-medium">{initials}</span>
      )}
    </div>
  );
}
