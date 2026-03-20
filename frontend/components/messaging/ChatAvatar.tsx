'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import { fetchBdAccountChatAvatarBlob, isLikelyAvatarImageBlob } from '@/lib/api/bd-accounts';
import { blobUrlCache, avatarChatKey } from '@/lib/cache/blob-url-cache';
import type { Chat } from '@/app/dashboard/messaging/types';
import { getChatDisplayName, getChatInitials } from '@/app/dashboard/messaging/utils';

interface ChatAvatarProps {
  bdAccountId: string;
  chatId: string;
  chat: Chat;
  className?: string;
}

function ChatAvatarInner({ bdAccountId, chatId, chat, className = 'w-10 h-10' }: ChatAvatarProps) {
  const [src, setSrc] = useState<string | null>(null);
  const mounted = useRef(true);
  const canFetch = typeof bdAccountId === 'string' && bdAccountId.trim() !== '' && typeof chatId === 'string' && chatId.trim() !== '';
  const key = canFetch ? avatarChatKey(bdAccountId.trim(), chatId.trim()) : '';

  useEffect(() => {
    if (!canFetch) {
      setSrc(null);
      return;
    }
    mounted.current = true;
    const cached = blobUrlCache.get(key);
    if (cached) {
      setSrc(cached);
      return () => { mounted.current = false; setSrc(null); };
    }
    const accountId = bdAccountId.trim();
    const cId = chatId.trim();
    fetchBdAccountChatAvatarBlob(accountId, cId)
      .then((blob) => {
        if (!mounted.current || !blob || !isLikelyAvatarImageBlob(blob)) return;
        const u = URL.createObjectURL(blob);
        blobUrlCache.set(key, u);
        setSrc(u);
      })
      .catch(() => {});
    return () => { mounted.current = false; setSrc(null); };
  }, [canFetch, bdAccountId, chatId, key]);

  const initials = getChatInitials(chat);
  const isGroup = chat.peer_type === 'chat' || chat.peer_type === 'channel';

  if (src) {
    return <img src={src} alt="" className={`rounded-full object-cover bg-muted shrink-0 ${className}`} />;
  }
  return (
    <div
      className={`rounded-full bg-primary/15 flex items-center justify-center text-primary font-semibold text-sm shrink-0 ${className}`}
      title={getChatDisplayName(chat)}
    >
      {isGroup ? <Users className="w-1/2 h-1/2" /> : initials}
    </div>
  );
}

export const ChatAvatar = React.memo(ChatAvatarInner);
