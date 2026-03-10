'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Reply, Check, CheckCheck } from 'lucide-react';
import { MessageContent } from '@/components/messaging/MessageContent';
import type { Message, Chat, LeadContext } from '@/app/dashboard/messaging/types';
import { getForwardedFromLabel, formatTime } from '@/app/dashboard/messaging/utils';

interface MessageBubbleProps {
  msg: Message;
  index: number;
  messages: Message[];
  selectedAccountId: string | null;
  selectedChat: Chat | null;
  readOutboxMaxIdByChannel: Record<string, number>;
  leadContext: LeadContext | null;
  onContextMenu: (e: React.MouseEvent, msg: Message) => void;
  onOpenMedia: (url: string, type: 'image' | 'video') => void;
  onScrollToMessage: (telegramMessageId: string) => void;
}

function MessageBubbleInner({
  msg,
  index,
  messages,
  selectedAccountId,
  selectedChat,
  readOutboxMaxIdByChannel,
  leadContext,
  onContextMenu,
  onOpenMedia,
  onScrollToMessage,
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const isOutbound = msg.direction === 'outbound';
  const msgTime = msg.telegram_date ?? msg.created_at;
  const prevMsgTime = messages[index - 1]?.telegram_date ?? messages[index - 1]?.created_at;
  const showDateSeparator =
    index === 0 || new Date(msgTime).toDateString() !== new Date(prevMsgTime).toDateString();

  const replyToTgId =
    msg.reply_to_telegram_id != null
      ? String(msg.reply_to_telegram_id).trim()
      : null;
  const repliedToMsg = replyToTgId
    ? messages.find((m) => String(m.telegram_message_id) === replyToTgId)
    : null;
  const replyPreviewText = repliedToMsg
    ? (repliedToMsg.content ?? '').trim().slice(0, 60) || t('messaging.replyPreviewMedia')
    : replyToTgId
      ? t('messaging.replyPreviewMedia')
      : '';

  const isSystemMessage = (msg.content ?? '').trim().startsWith('[System]');
  const isSharedChatCreated = isSystemMessage && (msg.content ?? '').includes('Общий чат создан');
  const sharedChatLinkUrl =
    isSharedChatCreated &&
    (leadContext?.shared_chat_invite_link?.trim()
      ? leadContext.shared_chat_invite_link.trim()
      : leadContext?.shared_chat_channel_id != null
        ? (() => {
            const raw = Number(leadContext.shared_chat_channel_id);
            const id = Number.isNaN(raw)
              ? String(leadContext.shared_chat_channel_id).replace(/^-100/, '')
              : String(Math.abs(raw));
            return id ? `https://t.me/c/${id}` : null;
          })()
        : null);

  const dateSeparator = showDateSeparator && (
    <div className="flex justify-center my-4">
      <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">
        {new Date(msgTime).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}
      </span>
    </div>
  );

  if (isSystemMessage) {
    return (
      <div data-telegram-message-id={msg.telegram_message_id ?? ''}>
        {dateSeparator}
        <div
          className="flex justify-center my-2"
          onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, msg); }}
        >
          <div className="max-w-[85%] rounded-lg border border-border/60 bg-muted/40 px-4 py-2.5 text-center">
            <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words text-left">
              {(msg.content ?? '').trim().replace(/^\[System\]\s*/, '')}
            </p>
            {sharedChatLinkUrl && (
              <a
                href={sharedChatLinkUrl as string}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 mt-2 text-sm text-primary hover:underline"
              >
                {t('messaging.openInTelegram', 'Открыть в Telegram')}
                <span aria-hidden>↗</span>
              </a>
            )}
            <div className="text-[10px] text-muted-foreground mt-1">{formatTime(msgTime)}</div>
          </div>
        </div>
      </div>
    );
  }

  const isGroupChat = selectedChat?.peer_type === 'chat' || selectedChat?.peer_type === 'channel';
  const showSenderName = !isOutbound && isGroupChat && (msg.sender_name ?? '').trim();
  const fwdLabel = getForwardedFromLabel(msg);
  const hasFwd = !!(fwdLabel || (msg.telegram_extra?.fwd_from && typeof msg.telegram_extra.fwd_from === 'object'));

  return (
    <div data-telegram-message-id={msg.telegram_message_id ?? ''}>
      {dateSeparator}
      <div
        className={`flex items-end gap-2 ${isOutbound ? 'flex-row-reverse' : 'flex-row'}`}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, msg); }}
      >
        <div className={`max-w-[70%] ${isOutbound ? 'msg-bubble-out' : 'msg-bubble-in'}`}>
          {showSenderName && (
            <div className="text-[11px] font-medium text-muted-foreground mb-0.5 truncate" title={msg.sender_name ?? undefined}>
              {msg.sender_name}
            </div>
          )}
          {replyToTgId && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); onScrollToMessage(replyToTgId); }}
              className={`w-full text-left border-l-2 rounded pl-2 py-1 mb-1.5 text-xs truncate transition-colors ${
                isOutbound
                  ? 'border-primary-foreground/50 text-primary-foreground/90 hover:bg-primary-foreground/10'
                  : 'border-primary text-muted-foreground hover:bg-muted/60'
              }`}
              title={t('messaging.scrollToMessage')}
            >
              <Reply className="w-3.5 h-3.5 inline-block mr-1 align-middle shrink-0" />
              <span className="align-middle">{replyPreviewText}{replyPreviewText.length >= 60 ? '…' : ''}</span>
            </button>
          )}
          {hasFwd && (
            <div
              className={`text-[11px] mb-1 truncate ${isOutbound ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}
              title={fwdLabel ? t('messaging.forwardedFrom', { name: fwdLabel }) : t('messaging.forwarded')}
            >
              {fwdLabel ? t('messaging.forwardedFrom', { name: fwdLabel }) : t('messaging.forwarded')}
            </div>
          )}
          <MessageContent
            msg={msg}
            isOutbound={isOutbound}
            bdAccountId={selectedAccountId ?? ''}
            channelId={selectedChat?.channel_id ?? ''}
            onOpenMedia={onOpenMedia}
          />
          <div
            className={`text-xs mt-1 flex items-center gap-1 ${
              isOutbound ? 'text-primary-foreground/80 justify-end' : 'text-muted-foreground justify-start'
            }`}
          >
            <span>{formatTime(msgTime)}</span>
            {isOutbound && (() => {
              const readMax = selectedChat ? readOutboxMaxIdByChannel[selectedChat.channel_id] : undefined;
              const tgId = msg.telegram_message_id != null ? Number(msg.telegram_message_id) : null;
              const isReadByReceipt = readMax != null && tgId != null && tgId <= readMax;
              const isRead = msg.status === 'read' || isReadByReceipt;
              return isRead ? (
                <CheckCheck className="w-3.5 h-3.5 text-primary-foreground ml-1" />
              ) : msg.status === 'sent' || msg.status === 'delivered' || (msg.status === 'pending' && tgId != null) ? (
                <Check className="w-3.5 h-3.5 text-primary-foreground/80 ml-1" />
              ) : null;
            })()}
          </div>
          {msg.reactions && Object.keys(msg.reactions).length > 0 && (
            <div className={`flex flex-wrap gap-1 mt-1 ${isOutbound ? 'justify-end' : 'justify-start'}`}>
              {Object.entries(msg.reactions).map(([emoji, count]) => (
                <span key={emoji} className="text-xs bg-muted/80 rounded px-1.5 py-0.5" title={t('messaging.reactionCount', { count })}>
                  {emoji} {count > 1 ? count : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const MessageBubble = React.memo(MessageBubbleInner);
