'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { MessageSquare, Loader2, User, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import {
  fetchCampaignParticipantRows,
  fetchCampaignParticipantAccounts,
  fetchCampaignAnalytics,
  type CampaignParticipantRow,
  type CampaignWithDetails,
  type SelectedContactInfo,
  type CampaignParticipantPhase,
  type CampaignParticipantAccount,
} from '@/lib/api/campaigns';
import { clsx } from 'clsx';

function accountInitials(displayName: string | null | undefined): string {
  if (!displayName || !displayName.trim()) return '?';
  const parts = displayName.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0] + parts[1]![0]).toUpperCase().slice(0, 2);
  return displayName.slice(0, 2).toUpperCase();
}

interface CampaignParticipantsTableProps {
  campaignId: string;
  campaign?: CampaignWithDetails | null;
  isActive: boolean;
  onRefresh?: () => void;
  onRemoveContact?: (contactId: string) => void;
  onRemoveAll?: () => void;
}

const PHASE_KEYS: Record<CampaignParticipantPhase, string> = {
  sent: 'campaigns.sent',
  read: 'campaigns.read',
  replied: 'campaigns.replied',
  shared: 'campaigns.shared',
  failed: 'campaigns.statusFailed',
  pending: 'campaigns.participantPhasePending',
  scheduled: 'campaigns.participantPhaseScheduled',
  skipped: 'campaigns.participantPhaseSkipped',
};

export function CampaignParticipantsTable({
  campaignId,
  campaign,
  isActive,
  onRefresh,
  onRemoveContact,
  onRemoveAll,
}: CampaignParticipantsTableProps) {
  const { t } = useTranslation();
  const [participants, setParticipants] = useState<CampaignParticipantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextPage, setNextPage] = useState(2);
  const [hasMore, setHasMore] = useState(true);
  const [filter, setFilter] = useState<'all' | 'replied' | 'not_replied' | 'shared'>('all');
  const [bdAccountId, setBdAccountId] = useState<string>('');
  const [sentFrom, setSentFrom] = useState<string>('');
  const [sentTo, setSentTo] = useState<string>('');
  const [accounts, setAccounts] = useState<CampaignParticipantAccount[]>([]);
  const [sendsByAccountByDay, setSendsByAccountByDay] = useState<{ date: string; accountId: string; accountDisplayName: string; sends: number }[]>([]);
  const [sendsByAccountExpanded, setSendsByAccountExpanded] = useState(false);
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
        bdAccountId: bdAccountId || undefined,
        sentFrom: sentFrom || undefined,
        sentTo: sentTo || undefined,
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
  }, [campaignId, showSelectedOnly, filter, bdAccountId, sentFrom, sentTo]);

  useEffect(() => {
    if (showSelectedOnly) return;
    fetchCampaignParticipantAccounts(campaignId).then(setAccounts).catch(() => setAccounts([]));
  }, [campaignId, showSelectedOnly]);

  useEffect(() => {
    if (showSelectedOnly) return;
    fetchCampaignAnalytics(campaignId, { days: 14 }).then((a) => setSendsByAccountByDay(a.sendsByAccountByDay ?? [])).catch(() => setSendsByAccountByDay([]));
  }, [campaignId, showSelectedOnly]);

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => load(), 30000);
    return () => clearInterval(id);
  }, [isActive, campaignId, filter, bdAccountId, sentFrom, sentTo]);

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
            <>
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
              {accounts.length > 0 && (
                <select
                  value={bdAccountId}
                  onChange={(e) => setBdAccountId(e.target.value)}
                  className="h-8 min-w-[120px] rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                >
                  <option value="">{t('campaigns.filterByAccountAll')}</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.displayName}</option>
                  ))}
                </select>
              )}
              <div className="flex items-center gap-1 text-xs">
                <input
                  type="date"
                  value={sentFrom}
                  onChange={(e) => setSentFrom(e.target.value)}
                  className="h-8 rounded border border-border bg-background px-2 text-foreground"
                  title={t('campaigns.sentFrom')}
                />
                <span className="text-muted-foreground">–</span>
                <input
                  type="date"
                  value={sentTo}
                  onChange={(e) => setSentTo(e.target.value)}
                  className="h-8 rounded border border-border bg-background px-2 text-foreground"
                  title={t('campaigns.sentTo')}
                />
              </div>
            </>
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
            <div className="px-4 py-2 text-sm text-muted-foreground border-b border-border flex flex-wrap items-center justify-between gap-2">
              <p className="mb-0">
                {t('campaigns.selectedContactsDraft', { count: selectedContacts.length, defaultValue: 'Выбрано контактов: {{count}}. Они станут участниками после запуска кампании.' })}
              </p>
              {onRemoveAll && selectedContacts.length > 0 && (
                <button
                  type="button"
                  onClick={() => onRemoveAll()}
                  className="text-destructive hover:underline text-sm font-medium"
                >
                  {t('campaigns.removeAllParticipants')}
                </button>
              )}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="text-left px-4 py-3 font-medium text-foreground">{t('campaigns.lead')}</th>
                  <th className="text-left px-4 py-3 font-medium text-foreground">Username</th>
                  <th className="text-left px-4 py-3 font-medium text-foreground">Telegram ID</th>
                  {onRemoveContact && <th className="w-12 px-4 py-3" />}
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
                    {onRemoveContact && (
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => onRemoveContact(c.id)}
                          className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                          aria-label={t('common.delete')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    )}
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
          <>
            {sendsByAccountByDay.length > 0 && (
              <div className="border-b border-border bg-muted/20">
                <button
                  type="button"
                  onClick={() => setSendsByAccountExpanded((v) => !v)}
                  className="w-full px-4 py-2 flex items-center gap-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                >
                  {sendsByAccountExpanded ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                  {t('campaigns.sendsByAccountByDay')} ({t('campaigns.periodDays', { count: 14 })})
                </button>
                {sendsByAccountExpanded && (
                  <div className="px-4 pb-2 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground">
                          <th className="text-left py-1 pr-3">{t('campaigns.date')}</th>
                          <th className="text-left py-1 pr-3">{t('campaigns.account')}</th>
                          <th className="text-right py-1">{t('campaigns.sendsCount')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sendsByAccountByDay.slice(0, 30).map((r, i) => (
                          <tr key={`${r.date}-${r.accountId}-${i}`} className="border-t border-border/50">
                            <td className="py-1 pr-3 text-foreground">{new Date(r.date).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}</td>
                            <td className="py-1 pr-3 text-foreground">{r.accountDisplayName}</td>
                            <td className="py-1 text-right font-medium">{r.sends}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="text-left px-4 py-3 font-medium text-foreground">{t('campaigns.lead')}</th>
                <th className="text-left px-4 py-3 font-medium text-foreground w-12" title={t('campaigns.accountColumnTitle')}>{t('campaigns.account')}</th>
                <th className="text-left px-4 py-3 font-medium text-foreground">{t('campaigns.status')}</th>
                <th className="text-left px-4 py-3 font-medium text-foreground hidden sm:table-cell">{t('campaigns.stepShort')}</th>
                <th className="text-left px-4 py-3 font-medium text-foreground hidden sm:table-cell">Pipeline</th>
                <th className="text-left px-4 py-3 font-medium text-foreground hidden md:table-cell">{t('campaigns.sent')}</th>
                <th className="text-left px-4 py-3 font-medium text-foreground hidden md:table-cell">{t('campaigns.replied')}</th>
                <th className="text-left px-4 py-3 font-medium text-foreground hidden md:table-cell">{t('campaigns.nextSendAt')}</th>
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
                  <td className="px-4 py-3" title={p.bd_account_display_name ?? p.bd_account_id ?? undefined}>
                    {p.bd_account_id ? (
                      <div
                        className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0 text-[10px] font-medium text-muted-foreground border border-border"
                        title={p.bd_account_display_name ?? p.bd_account_id}
                      >
                        {accountInitials(p.bd_account_display_name)}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={clsx(
                        'inline-flex px-2 py-0.5 rounded-full text-xs font-medium',
                        p.status_phase === 'shared' && 'bg-primary/20 text-primary',
                        p.status_phase === 'replied' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
                        p.status_phase === 'read' && 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
                        p.status_phase === 'sent' && 'bg-muted text-muted-foreground',
                        p.status_phase === 'failed' && 'bg-destructive/15 text-destructive',
                        p.status_phase === 'pending' && 'bg-amber-500/10 text-amber-800 dark:text-amber-200',
                        p.status_phase === 'scheduled' && 'bg-sky-500/10 text-sky-800 dark:text-sky-200',
                        p.status_phase === 'skipped' && 'bg-muted/80 text-muted-foreground'
                      )}
                      title={p.status_phase === 'failed' && p.last_error ? p.last_error : undefined}
                    >
                      {t(PHASE_KEYS[p.status_phase])}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs hidden sm:table-cell">
                    {typeof p.sequence_total_steps === 'number' && p.sequence_total_steps > 0
                      ? t('campaigns.stepOfTotal', {
                          current: (p.current_step ?? 0) + 1,
                          total: p.sequence_total_steps,
                        })
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{p.pipeline_stage_name ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell">{formatDate(p.sent_at)}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell">{formatDate(p.replied_at)}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell" title={p.next_send_at ?? undefined}>
                    {p.next_send_at ? formatDate(p.next_send_at) : '—'}
                  </td>
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
          </>
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
