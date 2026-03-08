'use client';

import React from 'react';
import { ChatAvatar } from './ChatAvatar';

function initialsFromName(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.replace(/^@/, '').split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase().slice(0, 2);
  if (trimmed.length >= 2) return trimmed.slice(0, 2).toUpperCase();
  return trimmed.slice(0, 1).toUpperCase();
}

export interface LeadContextAvatarProps {
  /** Contact name for initials fallback */
  contactName?: string | null;
  /** Telegram user id for avatar fetch (channel_id or contact_telegram_id) */
  telegramId?: string | null;
  bdAccountId?: string | null;
  className?: string;
}

export function LeadContextAvatar({ contactName, telegramId: telegramIdProp, bdAccountId, className = 'w-10 h-10' }: LeadContextAvatarProps) {
  const telegramId = telegramIdProp != null ? String(telegramIdProp).trim() || null : null;
  const canFetch = !!bdAccountId && !!telegramId;

  if (canFetch) {
    return (
      <ChatAvatar
        bdAccountId={bdAccountId!}
        chatId={telegramId!}
        chat={{
          channel_id: telegramId!,
          channel: 'telegram',
          peer_type: 'user',
          name: contactName ?? null,
          display_name: contactName ?? null,
        }}
        className={className}
      />
    );
  }

  const initials = contactName ? initialsFromName(contactName) : '?';
  return (
    <div
      className={`rounded-full bg-primary/15 flex items-center justify-center text-primary font-semibold text-sm shrink-0 ${className}`}
      title={contactName ?? ''}
    >
      {initials}
    </div>
  );
}

/** Convenience wrapper for LeadContext from messaging page */
export function LeadContextAvatarFromContext({
  leadContext,
  bdAccountId,
  className,
}: {
  leadContext: { contact_name?: string | null; channel_id?: string | null; contact_telegram_id?: string | null; bd_account_id?: string | null } | null;
  bdAccountId?: string | null;
  className?: string;
}) {
  const telegramId = leadContext?.channel_id ?? leadContext?.contact_telegram_id ?? null;
  return (
    <LeadContextAvatar
      contactName={leadContext?.contact_name}
      telegramId={telegramId}
      bdAccountId={leadContext?.bd_account_id ?? bdAccountId}
      className={className}
    />
  );
}
