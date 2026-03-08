'use client';

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Film, Music, File } from 'lucide-react';
import { LinkifyText } from '@/components/messaging/LinkifyText';
import { LinkPreview, extractFirstUrl } from '@/components/messaging/LinkPreview';
import { DownloadLink } from '@/components/messaging/DownloadLink';
import { blobUrlCache, mediaKey } from '@/lib/cache/blob-url-cache';
import type { Message } from '@/app/dashboard/messaging/types';
import { MEDIA_TYPE_I18N_KEYS } from '@/app/dashboard/messaging/types';
import { getMessageMediaType, getMediaProxyUrl } from '@/app/dashboard/messaging/utils';

/** Loads media with auth token and returns a blob URL. Uses LRU cache. */
function useMediaUrl(mediaUrl: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!mediaUrl) { setUrl(null); return; }
    const key = mediaKey(mediaUrl);
    const cached = blobUrlCache.get(key);
    if (cached) { setUrl(cached); return () => setUrl(null); }
    let cancelled = false;
    fetch(mediaUrl, { credentials: 'include' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('Failed to load media'))))
      .then((blob) => {
        const u = URL.createObjectURL(blob);
        if (cancelled) { URL.revokeObjectURL(u); return; }
        blobUrlCache.set(key, u);
        setUrl(u);
      })
      .catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; setUrl(null); };
  }, [mediaUrl]);
  return url;
}

interface MessageContentProps {
  msg: Message;
  isOutbound: boolean;
  bdAccountId: string | null;
  channelId: string;
  onOpenMedia?: (url: string, type: 'image' | 'video') => void;
}

function MessageContentInner({ msg, isOutbound, bdAccountId, channelId, onOpenMedia }: MessageContentProps) {
  const { t } = useTranslation();
  const mediaType = getMessageMediaType(msg);
  const label = mediaType === 'text' ? '' : t('messaging.' + MEDIA_TYPE_I18N_KEYS[mediaType]);
  const rawContent = (msg.content ?? '') || '';
  const isFilePlaceholderOnly = /^\[(Файл|File):\s*.+\]$/i.test(rawContent.trim());
  const hasCaption = !!rawContent.trim() && !(mediaType === 'photo' && isFilePlaceholderOnly);
  const textCls = 'text-sm leading-relaxed whitespace-pre-wrap break-words';
  const iconCls = isOutbound ? 'text-primary-foreground/80' : 'text-muted-foreground';
  const canLoadMedia =
    bdAccountId && channelId && msg.telegram_message_id && mediaType !== 'text' && mediaType !== 'unknown';

  const mediaApiUrl = canLoadMedia ? getMediaProxyUrl(bdAccountId!, channelId, msg.telegram_message_id!) : null;
  const mediaUrl = useMediaUrl(mediaApiUrl);

  const contentText = hasCaption ? rawContent : '';
  const firstUrl = contentText.trim() ? extractFirstUrl(contentText) : null;

  const textBlock = (
    <div>
      <div className={textCls}>
        {contentText.trim() ? (
          <LinkifyText text={contentText} className="break-words" />
        ) : mediaType === 'text' ? '\u00A0' : null}
      </div>
      {firstUrl && <LinkPreview url={firstUrl} />}
    </div>
  );

  if (mediaType === 'text') return textBlock;

  return (
    <div className="space-y-1">
      {mediaType === 'photo' && mediaUrl && (
        <button
          type="button"
          onClick={() => onOpenMedia?.(mediaUrl, 'image')}
          className="block rounded-lg overflow-hidden max-w-full min-h-[120px] text-left w-full"
        >
          <img src={mediaUrl} alt="" className="max-h-64 object-contain rounded w-full" />
        </button>
      )}
      {mediaType === 'photo' && !mediaUrl && canLoadMedia && (
        <div className="min-h-[120px] flex items-center justify-center rounded-lg bg-muted/50 max-w-[200px]">
          <Image className="w-8 h-8 text-muted-foreground animate-pulse" />
        </div>
      )}
      {mediaType === 'video' && mediaUrl && (
        <div className="relative group">
          <video src={mediaUrl} controls className="max-h-64 min-h-[120px] rounded-lg w-full" />
          <button
            type="button"
            onClick={() => onOpenMedia?.(mediaUrl, 'video')}
            className="absolute right-2 top-2 p-1.5 rounded-md bg-black/50 text-white hover:bg-black/70 transition-colors"
            title={t('messaging.openFullscreen')}
          >
            <Film className="w-4 h-4" />
          </button>
        </div>
      )}
      {mediaType === 'video' && !mediaUrl && canLoadMedia && (
        <div className="min-h-[120px] flex items-center justify-center rounded-lg bg-muted/50 max-w-[200px]">
          <Film className="w-8 h-8 text-muted-foreground animate-pulse" />
        </div>
      )}
      {(mediaType === 'voice' || mediaType === 'audio') && mediaUrl && (
        <audio src={mediaUrl} controls className="max-w-full" />
      )}
      {(!mediaUrl || mediaType === 'document' || mediaType === 'sticker') &&
        !(mediaType === 'photo' && canLoadMedia) &&
        !(mediaType === 'video' && canLoadMedia) && (
        <div className={`flex items-center gap-2 ${iconCls}`}>
          {mediaType === 'photo' && <Image className="w-4 h-4 shrink-0" />}
          {(mediaType === 'voice' || mediaType === 'audio') && !mediaUrl && <Music className="w-4 h-4 shrink-0" />}
          {mediaType === 'video' && !mediaUrl && <Film className="w-4 h-4 shrink-0" />}
          {(mediaType === 'document' || mediaType === 'unknown') && <File className="w-4 h-4 shrink-0" />}
          {mediaType === 'sticker' && mediaUrl && (
            <img src={mediaUrl} alt="" className="max-h-24 object-contain" />
          )}
          {mediaType === 'sticker' && !mediaUrl && <Image className="w-4 h-4 shrink-0" />}
          <span className="text-xs font-medium">{label}</span>
        </div>
      )}
      {mediaType === 'document' && mediaApiUrl && (
        <DownloadLink url={mediaApiUrl} className="text-xs underline" downloadLabel={t('messaging.download')} />
      )}
      {hasCaption && textBlock}
    </div>
  );
}

export const MessageContent = React.memo(MessageContentInner);
