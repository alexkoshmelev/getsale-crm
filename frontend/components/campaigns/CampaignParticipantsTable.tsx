'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { MessageSquare, Loader2, User } from 'lucide-react';
import { fetchCampaignParticipants, type CampaignParticipant } from '@/lib/api/campaigns';
import { clsx } from 'clsx';

interface CampaignParticipantsTableProps {
  campaignId: string;
  isActive: boolean;
  onRefresh?: () => void;
}

const STATUS_KEYS: Record<string, string> = {
  pending: 'campaigns.statusPending',
  sent: 'campaigns.statusSent',
  delivered: 'campaigns.statusDelivered',
  replied: 'campaigns.statusReplied',
  bounced: 'campaigns.statusBounced',
  stopped: 'campaigns.statusStopped',
};

export function CampaignParticipantsTable({
  campaignId,
  isActive,
  onRefresh,
}: CampaignParticipantsTableProps) {
  const { t } = useTranslation();
  const [participants, setParticipants] = useState<CampaignParticipant[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextPage, setNextPage] = useState(2);
  const [hasMore, setHasMore] = useState(true);
  const limit = 50;

  const load = async (append = false) => {
    if (!append) setLoading(true);
    else setLoadingMore(true);
    const pageToLoad = append ? nextPage : 1;
    try {
      const list = await fetchCampaignParticipants(campaignId, { page: pageToLoad, limit });
      if (append) setParticipants((prev) => [...prev, ...list]);
      else setParticipants(list);
      setHasMore(list.length >= limit);
      if (append) setNextPage((p) => p + 1);
      else setNextPage(2);
    } catch (e) {
      console.error('Failed to load participants', e);
      if (!append) setParticipants([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    load();
  }, [campaignId]);

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => load(), 30000);
    return () => clearInterval(id);
  }, [isActive, campaignId]);

  const displayName = (p: CampaignParticipant) => {
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
    if (name) return name;
    if (p.telegram_id) return p.telegram_id.startsWith('@') ? p.telegram_id : `@${p.telegram_id}`;
    return p.contact_id?.slice(0, 8) ?? '—';
  };

  const chatLink = (p: CampaignParticipant) => {
    if (p.bd_account_id && p.channel_id) {
      return `/dashboard/messaging?bdAccountId=${encodeURIComponent(p.bd_account_id)}&open=${encodeURIComponent(p.channel_id)}`;
    }
    return null;
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/30">
        <h3 className="font-heading text-base font-semibold text-foreground">
          {t('campaigns.participants')} {participants.length > 0 && <span className="text-muted-foreground font-normal">({participants.length})</span>}
        </h3>
        {isActive && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium animate-pulse">
            {t('campaigns.live')}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        {loading && participants.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : participants.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t('campaigns.noParticipantsYet')}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="text-left px-4 py-3 font-medium text-foreground">{t('campaigns.lead')}</th>
                <th className="text-left px-4 py-3 font-medium text-foreground">{t('campaigns.status')}</th>
                <th className="text-left px-4 py-3 font-medium text-foreground">{t('campaigns.stepShort')}</th>
                <th className="text-left px-4 py-3 font-medium text-foreground">{t('campaigns.nextSendAt')}</th>
                <th className="w-24 px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {participants.map((p) => (
                <tr key={p.id} className="border-b border-border/50 hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <User className="w-4 h-4 text-primary" />
                      </div>
                      <span className="font-medium text-foreground truncate max-w-[180px]" title={displayName(p)}>
                        {displayName(p)}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={clsx(
                        'inline-flex px-2 py-0.5 rounded-full text-xs font-medium',
                        p.status === 'replied' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
                        p.status === 'sent' && 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
                        p.status === 'pending' && 'bg-muted text-muted-foreground',
                        p.status === 'stopped' && 'bg-muted text-muted-foreground',
                        !['replied', 'sent', 'pending', 'stopped'].includes(p.status) && 'bg-muted text-muted-foreground'
                      )}
                    >
                      {t(STATUS_KEYS[p.status] || 'campaigns.statusPending')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{p.current_step + 1}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {p.next_send_at
                      ? new Date(p.next_send_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
                      : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {chatLink(p) ? (
                      <Link
                        href={chatLink(p)!}
                        className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                      >
                        <MessageSquare className="w-4 h-4" />
                        {t('campaigns.openChat')}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {hasMore && participants.length >= limit && (
        <div className="px-4 py-2 border-t border-border flex justify-center">
          <button
            type="button"
            onClick={() => load(true)}
            disabled={loadingMore}
            className="text-sm text-primary hover:underline disabled:opacity-50"
          >
            {loadingMore ? t('common.loading') : t('campaigns.loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}
