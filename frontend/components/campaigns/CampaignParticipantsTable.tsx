'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { MessageSquare, Loader2, User } from 'lucide-react';
import {
  fetchCampaignParticipantRows,
  type CampaignParticipantRow,
  type CampaignWithDetails,
  type SelectedContactInfo,
  type CampaignParticipantPhase,
} from '@/lib/api/campaigns';
import { clsx } from 'clsx';

interface CampaignParticipantsTableProps {
  campaignId: string;
  campaign?: CampaignWithDetails | null;
  isActive: boolean;
  onRefresh?: () => void;
}

const PHASE_KEYS: Record<CampaignParticipantPhase, string> = {
  sent: 'campaigns.sent',
  read: 'campaigns.read',
  replied: 'campaigns.replied',
  shared: 'campaigns.shared',
};

export function CampaignParticipantsTable({
  campaignId,
  campaign,
  isActive,
  onRefresh,
}: CampaignParticipantsTableProps) {
  const { t } = useTranslation();
  const [participants, setParticipants] = useState<CampaignParticipantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextPage, setNextPage] = useState(2);
  const [hasMore, setHasMore] = useState(true);
  const [filter, setFilter] = useState<'all' | 'replied' | 'not_replied' | 'shared'>('all');
  const limit = 50;

  const selectedContacts = (campaign?.status === 'draft' || campaign?.status === 'paused')
    ? (campaign.selected_contacts ?? [])
    : [];
  const showSelectedOnly = !isActive && selectedContacts.length > 0;

  const load = async (append = false) => {
    if (showSelectedOnly) return;
    if (!append) setLoading(true);
    else setLoadingMore(true);
    const pageToLoad = append ? nextPage : 1;
    try {
      const list = await fetchCampaignParticipantRows(campaignId, {
        page: pageToLoad,
        limit,
        filter: filter === 'all' ? undefined : filter,
      });
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
    if (showSelectedOnly) {
      setLoading(false);
      setParticipants([]);
      return;
    }
    load();
  }, [campaignId, showSelectedOnly, filter]);

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => load(), 30000);
    return () => clearInterval(id);
  }, [isActive, campaignId, filter]);

  const selectedDisplayName = (c: SelectedContactInfo) => {
    const name = (c.display_name || [c.first_name, c.last_name].filter(Boolean).join(' ')).trim();
    if (name) return name;
    if (c.username) return `@${c.username.replace(/^@/, '')}`;
    if (c.telegram_id) return c.telegram_id;
    return c.id.slice(0, 8);
  };

  const chatLink = (p: CampaignParticipantRow) => {
    if (p.bd_account_id && p.channel_id) {
      return `/dashboard/messaging?bdAccountId=${encodeURIComponent(p.bd_account_id)}&open=${encodeURIComponent(p.channel_id)}`;
    }
    return null;
  };

  const formatDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-muted/30">
        <h3 className="font-heading text-base font-semibold text-foreground">
          {t('campaigns.participants')} {(showSelectedOnly ? selectedContacts.length : participants.length) > 0 && (
            <span className="text-muted-foreground font-normal">({showSelectedOnly ? selectedContacts.length : participants.length})</span>
          )}
        </h3>
        <div className="flex items-center gap-2 flex-wrap">
          {!showSelectedOnly && (
            <div className="flex rounded-lg border border-border p-0.5 bg-background">
              {(['all', 'replied', 'not_replied', 'shared'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={clsx(
                    'px-2 py-1 text-xs font-medium rounded-md transition-colors',
                    filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t(`campaigns.filter${f === 'all' ? 'All' : f === 'replied' ? 'Replied' : f === 'not_replied' ? 'NotReplied' : 'Shared'}`)}
                </button>
              ))}
            </div>
          )}
          {isActive && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium animate-pulse">
              {t('campaigns.live')}
            </span>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        {showSelectedOnly ? (
          <>
            <p className="px-4 py-2 text-sm text-muted-foreground border-b border-border">
              {t('campaigns.selectedContactsDraft', { count: selectedContacts.length, defaultValue: 'Выбрано контактов: {{count}}. Они станут участниками после запуска кампании.' })}
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="text-left px-4 py-3 font-medium text-foreground">{t('campaigns.lead')}</th>
                  <th className="text-left px-4 py-3 font-medium text-foreground">Username</th>
                  <th className="text-left px-4 py-3 font-medium text-foreground">Telegram ID</th>
                </tr>
              </thead>
              <tbody>
                {selectedContacts.map((c) => (
                  <tr key={c.id} className="border-b border-border/50 hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <User className="w-4 h-4 text-primary" />
                        </div>
                        <span className="font-medium text-foreground truncate max-w-[200px]" title={selectedDisplayName(c)}>
                          {selectedDisplayName(c)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{c.username ? `@${c.username.replace(/^@/, '')}` : '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{c.telegram_id ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : loading && participants.length === 0 ? (
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
                <th className="text-left px-4 py-3 font-medium text-foreground hidden sm:table-cell">Pipeline</th>
                <th className="text-left px-4 py-3 font-medium text-foreground hidden md:table-cell">{t('campaigns.sent')}</th>
                <th className="text-left px-4 py-3 font-medium text-foreground hidden md:table-cell">{t('campaigns.replied')}</th>
                <th className="w-24 px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {participants.map((p) => (
                <tr key={p.participant_id} className="border-b border-border/50 hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <User className="w-4 h-4 text-primary" />
                      </div>
                      <span className="font-medium text-foreground truncate max-w-[180px]" title={p.contact_name}>
                        {p.contact_name || '—'}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={clsx(
                        'inline-flex px-2 py-0.5 rounded-full text-xs font-medium',
                        p.status_phase === 'shared' && 'bg-primary/20 text-primary',
                        p.status_phase === 'replied' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
                        p.status_phase === 'read' && 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
                        p.status_phase === 'sent' && 'bg-muted text-muted-foreground'
                      )}
                    >
                      {t(PHASE_KEYS[p.status_phase])}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{p.pipeline_stage_name ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell">{formatDate(p.sent_at)}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell">{formatDate(p.replied_at)}</td>
                  <td className="px-4 py-3">
                    {chatLink(p) ? (
                      <Link
                        href={chatLink(p)!}
                        className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                      >
                        <MessageSquare className="w-4 h-4" />
                        {t('campaigns.openDialog')}
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
