'use client';

import { useState, useEffect, useRef } from 'react';
import { ExternalLink } from 'lucide-react';
import { apiClient } from '@/lib/api/client';

const URL_REGEX = /(https?:\/\/[^\s<>\]\)]+)/gi;

export function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_REGEX);
  return match && match[0] ? match[0] : null;
}

interface UnfurlData {
  title: string | null;
  description: string | null;
  image: string | null;
}

const cache = new Map<string, UnfurlData | 'loading' | 'error'>();

export function LinkPreview({ url, className = '' }: { url: string; className?: string }) {
  const [data, setData] = useState<UnfurlData | null>(() => {
    const c = cache.get(url);
    return c && c !== 'loading' && c !== 'error' ? c : null;
  });
  const [loading, setLoading] = useState(() => cache.get(url) === 'loading');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const cached = cache.get(url);
    if (cached && cached !== 'loading' && cached !== 'error') {
      setData(cached);
      setLoading(false);
      return () => { mounted.current = false; };
    }
    if (cached === 'loading') {
      return () => { mounted.current = false; };
    }
    cache.set(url, 'loading');
    setLoading(true);
    apiClient
      .get<UnfurlData>('/api/messaging/unfurl', { params: { url } })
      .then((res) => {
        const d = res.data;
        const result = {
          title: d?.title ?? null,
          description: d?.description ?? null,
          image: d?.image ?? null,
        };
        cache.set(url, result);
        if (mounted.current) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(() => {
        cache.set(url, 'error');
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [url]);

  if (loading || (!data?.title && !data?.description && !data?.image)) {
    if (loading) {
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={`mt-1.5 flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50 ${className}`}
        >
          <ExternalLink className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate flex-1">{url}</span>
        </a>
      );
    }
    return null;
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`mt-1.5 flex overflow-hidden rounded-lg border border-border bg-muted/30 hover:bg-muted/50 transition-colors text-left max-w-[280px] ${className}`}
    >
      {data.image && (
        <div className="w-16 h-16 shrink-0 bg-muted">
          <img
            src={data.image}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        </div>
      )}
      <div className="min-w-0 flex-1 p-2.5 flex flex-col justify-center">
        {data.title && (
          <span className="text-xs font-medium text-foreground line-clamp-2">{data.title}</span>
        )}
        {data.description && !data.title && (
          <span className="text-xs text-muted-foreground line-clamp-2">{data.description}</span>
        )}
        {data.description && data.title && (
          <span className="text-[11px] text-muted-foreground line-clamp-1 mt-0.5">{data.description}</span>
        )}
      </div>
      <ExternalLink className="w-3.5 h-3.5 shrink-0 text-muted-foreground m-2 self-center" />
    </a>
  );
}
