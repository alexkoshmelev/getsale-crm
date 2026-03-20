'use client';

import React, { useEffect, useRef, useState } from 'react';
import { fetchBdAccountChatAvatarBlob } from '@/lib/api/bd-accounts';
import { blobUrlCache, avatarChatKey } from '@/lib/cache/blob-url-cache';
import type { Lead } from '@/lib/api/pipeline';

function leadInitials(lead: Lead): string {
  const name = leadContactName(lead);
  const parts = name.replace(/^@/, '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0]! + parts[parts.length - 1]![0]).toUpperCase().slice(0, 2);
  if (name.length >= 2) return name.slice(0, 2).toUpperCase();
  return name.slice(0, 1).toUpperCase() || '?';
}

function leadContactName(lead: Lead): string {
  const display = (lead.display_name ?? '').trim();
  if (display) return display;
  const parts = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
  return parts || (lead.username ?? '').trim() || (lead.email ?? '').trim() || (lead.telegram_id ?? '').trim() || '—';
}

export interface LeadAvatarProps {
  lead: Lead;
  /** First BD account id for loading Telegram avatar (same API as messaging chat list). */
  bdAccountId?: string | null;
  className?: string;
}

function LeadAvatarInner({ lead, bdAccountId, className = 'w-9 h-9' }: LeadAvatarProps) {
  const [src, setSrc] = useState<string | null>(null);
  const mounted = useRef(true);
  const telegramId = lead.telegram_id ?? null;
  const key = bdAccountId && telegramId ? avatarChatKey(bdAccountId, telegramId) : '';

  useEffect(() => {
    if (!bdAccountId || !telegramId) return;
    mounted.current = true;
    const cached = blobUrlCache.get(key);
    if (cached) {
      setSrc(cached);
      return () => { mounted.current = false; setSrc(null); };
    }
    fetchBdAccountChatAvatarBlob(bdAccountId, telegramId)
      .then((blob) => {
        if (mounted.current && blob) {
          const u = URL.createObjectURL(blob);
          blobUrlCache.set(key, u);
          setSrc(u);
        }
      })
      .catch(() => {});
    return () => { mounted.current = false; setSrc(null); };
  }, [bdAccountId, telegramId, key]);

  const initials = leadInitials(lead);

  if (src) {
    return <img src={src} alt="" className={`rounded-full object-cover bg-muted shrink-0 ${className}`} />;
  }
  return (
    <div
      className={`rounded-full bg-primary/15 flex items-center justify-center text-primary font-semibold text-sm shrink-0 ${className}`}
      title={leadContactName(lead)}
    >
      {initials}
    </div>
  );
}

export const LeadAvatar = React.memo(LeadAvatarInner);
