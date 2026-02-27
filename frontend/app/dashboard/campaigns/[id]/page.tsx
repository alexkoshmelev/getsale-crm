'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import {
  Send,
  Play,
  PauseCircle,
  Square,
  ArrowLeft,
  Users,
  BarChart3,
  Loader2,
  SendHorizontal,
  MessageCircle,
  UserX,
  Clock,
  Calendar,
  Percent,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import {
  fetchCampaign,
  fetchCampaignStats,
  fetchCampaignAnalytics,
  startCampaign,
  pauseCampaign,
  updateCampaign,
  enrichContactsFromTelegram,
  type CampaignWithDetails,
  type CampaignStats,
  type CampaignAnalytics,
} from '@/lib/api/campaigns';
import { SequenceBuilderCanvas } from '@/components/campaigns/SequenceBuilderCanvas';
import { CampaignAudienceSchedule } from '@/components/campaigns/CampaignAudienceSchedule';
import { CampaignParticipantsTable } from '@/components/campaigns/CampaignParticipantsTable';
import { Modal } from '@/components/ui/Modal';
import { clsx } from 'clsx';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Line,
  ComposedChart,
} from 'recharts';

const PRELAUNCH_SEEN_KEY = 'getsale-campaign-prelaunch-seen';

type Tab = 'overview' | 'participants' | 'sequence' | 'audience';

/** Форматирует длительность динамически: минуты, часы, дни, недели. */
function formatDuration(start: string, end: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  const diffMs = Math.max(0, b - a);
  const diffMin = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffMin < 60) return t('campaigns.durationMinutes', { count: diffMin });
  if (diffHours < 24) return t('campaigns.durationHours', { count: diffHours });
  if (diffDays < 7) return t('campaigns.durationDays', { count: diffDays });
  return t('campaigns.durationWeeks', { count: diffWeeks });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function CampaignAnalyticsChart({
  analytics,
  t,
}: {
  analytics: CampaignAnalytics;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const sendsMap = new Map(analytics.sendsByDay.map((r) => [r.date, r.sends]));
  const repliedMap = new Map(analytics.repliedByDay.map((r) => [r.date, r.replied]));
  const allDates = new Set([...sendsMap.keys(), ...repliedMap.keys()]);
  const sortedDates = Array.from(allDates).sort();
  const chartData = sortedDates.map((date) => {
    const sends = sendsMap.get(date) ?? 0;
    const replied = repliedMap.get(date) ?? 0;
    const conversion = sends > 0 ? Math.round((replied / sends) * 100) : 0;
    return {
      date: new Date(date).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }),
      fullDate: date,
      sends,
      replied,
      conversion,
    };
  });

  if (chartData.length === 0) return null;

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 8, right: 32, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} className="text-muted-foreground" />
          <YAxis yAxisId="left" tick={{ fontSize: 11 }} allowDecimals={false} width={28} />
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} width={32} tickFormatter={(v) => `${v}%`} domain={[0, 100]} />
          <Tooltip
            contentStyle={{ borderRadius: 10, border: '1px solid var(--border)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
            labelFormatter={(_, payload) => payload?.[0]?.payload?.fullDate}
            formatter={(value: number, name: string, props: { payload?: { conversion?: number } }) => {
              if (name === 'conversion') return [props.payload?.conversion ?? 0, t('campaigns.conversion')];
              return [value, name === 'sends' ? t('campaigns.sent') : t('campaigns.replied')];
            }}
            labelStyle={{ fontWeight: 600 }}
          />
          <Legend
            formatter={(value) =>
              value === 'conversion' ? t('campaigns.conversion') : value === 'sends' ? t('campaigns.sent') : t('campaigns.replied')
            }
          />
          <Bar dataKey="sends" fill="hsl(var(--primary) / 0.85)" name="sends" radius={[4, 4, 0, 0]} yAxisId="left" maxBarSize={36} />
          <Bar dataKey="replied" fill="hsl(142.1 56% 42%)" name="replied" radius={[4, 4, 0, 0]} yAxisId="left" maxBarSize={36} />
          <Line type="monotone" dataKey="conversion" name="conversion" stroke="hsl(38 92% 50%)" strokeWidth={2} dot={{ r: 3 }} yAxisId="right" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function CampaignDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const { t } = useTranslation();
  const id = params?.id as string;
  const tabFromUrl = (searchParams?.get('tab') || 'overview') as Tab;
  const [tab, setTab] = useState<Tab>(
    ['overview', 'sequence', 'audience', 'participants'].includes(tabFromUrl) ? tabFromUrl : 'overview'
  );
  const [campaign, setCampaign] = useState<CampaignWithDetails | null>(null);
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [analytics, setAnalytics] = useState<CampaignAnalytics | null>(null);
  const [analyticsDays, setAnalyticsDays] = useState(14);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [showPreLaunchModal, setShowPreLaunchModal] = useState(false);
  const [pendingStartAfterModal, setPendingStartAfterModal] = useState(false);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [c, s] = await Promise.all([
        fetchCampaign(id),
        fetchCampaignStats(id).catch(() => null),
      ]);
      setCampaign(c);
      setStats(s || null);
    } catch (e) {
      console.error('Failed to load campaign', e);
      setCampaign(null);
      setStats(null);
    } finally {
      setLoading(false);
    }
  };

  const loadAnalytics = async () => {
    if (!id) return;
    try {
      const a = await fetchCampaignAnalytics(id, { days: analyticsDays });
      setAnalytics(a);
    } catch (e) {
      console.error('Failed to load campaign analytics', e);
      setAnalytics(null);
    }
  };

  useEffect(() => {
    if (id && tab === 'overview') loadAnalytics();
  }, [id, tab, analyticsDays]);

  useEffect(() => {
    const tabParam = searchParams?.get('tab');
    if (tabParam === 'sequence' || tabParam === 'overview' || tabParam === 'audience' || tabParam === 'participants') setTab(tabParam);
  }, [searchParams]);

  useEffect(() => {
    load();
  }, [id]);

  const isActive = campaign?.status === 'active';
  useEffect(() => {
    if (!id || !isActive) return;
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [id, isActive]);

  const doStart = async () => {
    if (!id || !campaign) return;
    setActionLoading(true);
    try {
      const aud = campaign.target_audience || {};
      const contactIds = Array.isArray(aud.contactIds) ? aud.contactIds : [];
      if (aud.enrichContactsBeforeStart && contactIds.length > 0) {
        try {
          await enrichContactsFromTelegram(contactIds, aud.bdAccountId);
        } catch (e) {
          console.warn('Enrich contacts before start failed:', e);
        }
      }
      await startCampaign(id);
      load();
    } catch (e) {
      console.error('Failed to start campaign', e);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStart = () => {
    if (!id) return;
    if (typeof window !== 'undefined' && !localStorage.getItem(PRELAUNCH_SEEN_KEY)) {
      setPendingStartAfterModal(true);
      setShowPreLaunchModal(true);
      return;
    }
    doStart();
  };

  const handlePreLaunchClose = () => {
    if (pendingStartAfterModal) {
      if (typeof window !== 'undefined') localStorage.setItem(PRELAUNCH_SEEN_KEY, '1');
      setPendingStartAfterModal(false);
      doStart();
    }
    setShowPreLaunchModal(false);
  };

  const handlePause = async () => {
    if (!id) return;
    setActionLoading(true);
    try {
      await pauseCampaign(id);
      load();
    } catch (e) {
      console.error('Failed to pause campaign', e);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    if (!id || !confirm(t('campaigns.stopCampaignConfirm'))) return;
    setActionLoading(true);
    try {
      await updateCampaign(id, { status: 'completed' });
      load();
    } catch (e) {
      console.error('Failed to stop campaign', e);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading && !campaign) {
    return (
      <div className="flex items-center justify-center min-h-[320px]">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" aria-hidden />
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="space-y-4">
        <Link href="/dashboard/campaigns" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" />
          {t('common.back')}
        </Link>
        <p className="text-muted-foreground">{t('common.noData')}</p>
      </div>
    );
  }

  const canStart = campaign.status === 'draft' || campaign.status === 'paused' || campaign.status === 'completed';
  const canPause = campaign.status === 'active';
  const canStop = campaign.status === 'active' || campaign.status === 'paused';
  const isCompleted = campaign.status === 'completed';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <Link
          href="/dashboard/campaigns"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground w-fit"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('common.back')}
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-primary/10 p-3">
              <Send className="w-8 h-8 text-primary" />
            </div>
            <div>
              <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight">
                {campaign.name}
              </h1>
              <span
                className={clsx(
                  'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
                  campaign.status === 'draft' && 'bg-muted text-muted-foreground',
                  campaign.status === 'active' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
                  campaign.status === 'paused' && 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
                  campaign.status === 'completed' && 'bg-muted text-muted-foreground'
                )}
              >
                {t(`campaigns.status${campaign.status.charAt(0).toUpperCase() + campaign.status.slice(1)}`)}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canStart && (
              <Button onClick={handleStart} disabled={actionLoading}>
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                {isCompleted
                  ? t('campaigns.startAgain')
                  : campaign.status === 'paused'
                    ? t('campaigns.resumeCampaign')
                    : t('campaigns.startCampaign')}
              </Button>
            )}
            {canPause && (
              <Button variant="outline" onClick={handlePause} disabled={actionLoading}>
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <PauseCircle className="w-4 h-4 mr-2" />}
                {t('campaigns.pauseCampaign')}
              </Button>
            )}
            {canStop && (
              <Button variant="outline" onClick={handleStop} disabled={actionLoading} className="text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30">
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4 mr-2" />}
                {t('campaigns.stopCampaign')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <nav className="flex gap-1 border-b border-border" aria-label={t('campaigns.settings')}>
        <button
          type="button"
          onClick={() => setTab('overview')}
          className={clsx(
            'px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors',
            tab === 'overview'
              ? 'bg-card text-foreground border border-border border-b-0 -mb-px'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
          )}
        >
          {t('campaigns.overview')}
        </button>
        <button
          type="button"
          onClick={() => setTab('audience')}
          className={clsx(
            'px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors',
            tab === 'audience'
              ? 'bg-card text-foreground border border-border border-b-0 -mb-px'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
          )}
        >
          {t('campaigns.audience')}
        </button>
        <button
          type="button"
          onClick={() => setTab('participants')}
          className={clsx(
            'px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors',
            tab === 'participants'
              ? 'bg-card text-foreground border border-border border-b-0 -mb-px'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
          )}
        >
          {t('campaigns.participants')}
        </button>
        <button
          type="button"
          onClick={() => setTab('sequence')}
          className={clsx(
            'px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors',
            tab === 'sequence'
              ? 'bg-card text-foreground border border-border border-b-0 -mb-px'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
          )}
        >
          {t('campaigns.sequence')}
        </button>
      </nav>

      {tab === 'overview' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <button
              type="button"
              onClick={() => { setPendingStartAfterModal(false); setShowPreLaunchModal(true); }}
              className="text-sm text-primary hover:underline"
            >
              {t('campaigns.bestPracticesLink')}
            </button>
          </div>

          {stats && (
            <>
              {isActive && (
                <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  {t('campaigns.live')}
                </div>
              )}

              {/* PHASE 2.5 + 2.7 — KPI: Sent, Read, Replied, Shared, Won, Lost, Revenue */}
              {(stats.total_sent != null && stats.total_sent > 0) && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
                    <div className="rounded-xl border border-border bg-card p-4">
                      <p className="text-2xl font-bold text-foreground tabular-nums">{stats.total_sent ?? 0}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{t('campaigns.sent')}</p>
                    </div>
                    <div className="rounded-xl border border-border bg-card p-4">
                      <p className="text-2xl font-bold text-foreground tabular-nums">{stats.total_read ?? 0}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{stats.read_rate != null ? `${stats.read_rate}%` : ''} {t('campaigns.read')}</p>
                    </div>
                    <div className="rounded-xl border border-border bg-card p-4">
                      <p className="text-2xl font-bold text-foreground tabular-nums">{stats.total_replied ?? 0}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{stats.reply_rate != null ? `${stats.reply_rate}%` : ''} {t('campaigns.replied')}</p>
                    </div>
                    <div className="rounded-xl border border-border bg-card p-4">
                      <p className="text-2xl font-bold text-foreground tabular-nums">{stats.total_converted_to_shared_chat ?? 0}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{stats.conversion_rate != null ? `${stats.conversion_rate}%` : ''} {t('campaigns.shared')}</p>
                    </div>
                    <div className="rounded-xl border border-border bg-card p-4">
                      <p className="text-2xl font-bold text-foreground tabular-nums">{stats.total_won ?? 0}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{stats.win_rate != null ? `${stats.win_rate}%` : ''} {t('campaigns.won')}</p>
                    </div>
                  </div>
                  {(stats.total_won != null || stats.total_lost != null || (stats.total_revenue != null && stats.total_revenue > 0)) && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="rounded-xl border border-border bg-card p-4">
                        <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{(stats.total_revenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} €</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{t('campaigns.totalRevenue')}</p>
                      </div>
                      <div className="rounded-xl border border-border bg-card p-4">
                        <p className="text-xl font-bold text-foreground tabular-nums">{stats.total_lost ?? 0}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{t('campaigns.lost')}</p>
                      </div>
                      {(stats.avg_revenue_per_won != null && stats.avg_revenue_per_won > 0) && (
                        <div className="rounded-xl border border-border bg-card p-4">
                          <p className="text-xl font-bold text-foreground tabular-nums">{stats.avg_revenue_per_won.toLocaleString(undefined, { maximumFractionDigits: 2 })} €</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{t('campaigns.avgDealSize')}</p>
                        </div>
                      )}
                      {(stats.avg_time_to_won_hours != null && stats.avg_time_to_won_hours > 0) && (
                        <div className="rounded-xl border border-border bg-card p-4">
                          <p className="text-xl font-bold text-foreground tabular-nums">{stats.avg_time_to_won_hours}h</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{t('campaigns.avgTimeToWon')}</p>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* PHASE 2.5 + 2.7 — воронка Sent → Read → Replied → Shared → Won; Lost отдельно */}
              {(stats.total_sent != null && stats.total_sent > 0) && (
                <div className="rounded-xl border border-border bg-card p-4">
                  <h3 className="text-sm font-medium text-muted-foreground mb-3">{t('campaigns.funnel')}</h3>
                  <div className="flex flex-wrap items-end gap-2 sm:gap-3">
                    <div className="flex flex-col items-center min-w-[3.5rem]">
                      <div className="w-full h-8 rounded bg-primary/20 flex items-center justify-center">
                        <span className="text-sm font-semibold tabular-nums">{stats.total_sent ?? 0}</span>
                      </div>
                      <span className="text-xs text-muted-foreground mt-1">{t('campaigns.sent')}</span>
                    </div>
                    <span className="self-center text-muted-foreground">→</span>
                    <div className="flex flex-col items-center min-w-[3.5rem]">
                      <div className="w-full h-8 rounded bg-primary/30 flex items-center justify-center">
                        <span className="text-sm font-semibold tabular-nums">{stats.total_read ?? 0}</span>
                      </div>
                      <span className="text-xs text-muted-foreground mt-1">{t('campaigns.read')}</span>
                    </div>
                    <span className="self-center text-muted-foreground">→</span>
                    <div className="flex flex-col items-center min-w-[3.5rem]">
                      <div className="w-full h-8 rounded bg-primary/50 flex items-center justify-center">
                        <span className="text-sm font-semibold tabular-nums">{stats.total_replied ?? 0}</span>
                      </div>
                      <span className="text-xs text-muted-foreground mt-1">{t('campaigns.replied')}</span>
                    </div>
                    <span className="self-center text-muted-foreground">→</span>
                    <div className="flex flex-col items-center min-w-[3.5rem]">
                      <div className="w-full h-8 rounded bg-primary flex items-center justify-center">
                        <span className="text-sm font-semibold tabular-nums text-primary-foreground">{stats.total_converted_to_shared_chat ?? 0}</span>
                      </div>
                      <span className="text-xs text-muted-foreground mt-1">{t('campaigns.shared')}</span>
                    </div>
                    <span className="self-center text-muted-foreground">→</span>
                    <div className="flex flex-col items-center min-w-[3.5rem]">
                      <div className="w-full h-8 rounded bg-emerald-500 flex items-center justify-center">
                        <span className="text-sm font-semibold tabular-nums text-white">{stats.total_won ?? 0}</span>
                      </div>
                      <span className="text-xs text-muted-foreground mt-1">{t('campaigns.won')}</span>
                    </div>
                  </div>
                  {(stats.total_lost != null && stats.total_lost > 0) && (
                    <div className="mt-3 pt-3 border-t border-border flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{t('campaigns.lost')}:</span>
                      <span className="text-sm font-semibold tabular-nums">{stats.total_lost}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Даты кампании */}
              {(stats.firstSendAt || stats.lastSendAt) && (
                <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
                  <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                    <Calendar className="w-4 h-4" />
                    {t('campaigns.campaignDatesSection')}
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">{t('campaigns.campaignStartDate')}</p>
                      <p className="text-sm font-medium text-foreground">
                        {stats.firstSendAt ? formatDateTime(stats.firstSendAt) : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">{t('campaigns.campaignEndDate')}</p>
                      <p className="text-sm font-medium text-foreground">
                        {stats.lastSendAt ? formatDateTime(stats.lastSendAt) : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-0.5">{t('campaigns.campaignDuration')}</p>
                      <p className="text-sm font-medium text-foreground">
                        {stats.firstSendAt && stats.lastSendAt
                          ? formatDuration(stats.firstSendAt, stats.lastSendAt, t)
                          : t('campaigns.noDatesYet')}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Конверсия — главный параметр */}
              <div className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="p-5 sm:p-6 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent dark:from-primary/20 dark:via-primary/10">
                  <div className="flex flex-wrap items-end gap-6">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-1 flex items-center gap-1.5">
                        <Percent className="w-4 h-4" />
                        {t('campaigns.conversion')}
                      </p>
                      <p className="text-4xl sm:text-5xl font-bold text-foreground tabular-nums">
                        {typeof stats.conversionRate === 'number' ? stats.conversionRate : 0}%
                      </p>
                      <p className="text-sm text-muted-foreground mt-1">
                        {t('campaigns.conversionSubtitle', {
                          replied: stats.byStatus?.replied ?? 0,
                          total: stats.total,
                        })}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-px bg-border">
                  <div className="bg-card p-4">
                    <p className="text-xs text-muted-foreground mb-0.5">{t('campaigns.totalParticipants')}</p>
                    <p className="text-xl font-semibold text-foreground">{stats.total}</p>
                  </div>
                  <div className="bg-card p-4">
                    <p className="text-xs text-muted-foreground mb-0.5">{t('campaigns.sent')}</p>
                    <p className="text-xl font-semibold text-foreground">
                      {typeof stats.contactsSent === 'number' ? stats.contactsSent : (stats.byStatus?.sent ?? 0)}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{t('campaigns.sentContactsHint', 'контактов получили сообщения')}</p>
                  </div>
                  <div className="bg-card p-4">
                    <p className="text-xs text-muted-foreground mb-0.5">{t('campaigns.replied')}</p>
                    <p className="text-xl font-semibold text-foreground">{stats.byStatus?.replied ?? 0}</p>
                  </div>
                </div>
              </div>

              {/* Доп. статусы: ожидает, остановлено — одна строка */}
              <div className="flex flex-wrap gap-3 text-sm">
                <span className="text-muted-foreground">
                  {t('campaigns.statusPending')}: <strong className="text-foreground">{stats.byStatus?.pending ?? 0}</strong>
                </span>
                <span className="text-muted-foreground">
                  {t('campaigns.stopped')}: <strong className="text-foreground">{stats.byStatus?.stopped ?? 0}</strong>
                </span>
              </div>
            </>
          )}

          {/* График: отправки, ответы, конверсия по дням */}
          <div className="rounded-xl border border-border bg-card p-6">
            <h3 className="font-heading text-lg font-semibold text-foreground mb-4">
              {t('campaigns.analyticsTitle')}
            </h3>
            <div className="flex flex-wrap gap-2 mb-4 items-center">
              <label htmlFor="analytics-days" className="text-sm text-muted-foreground">
                {t('campaigns.byDays')}:
              </label>
              <select
                id="analytics-days"
                value={analyticsDays}
                onChange={(e) => setAnalyticsDays(Number(e.target.value))}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value={7}>{t('campaigns.periodDays', { count: 7 })}</option>
                <option value={14}>{t('campaigns.periodDays', { count: 14 })}</option>
                <option value={30}>{t('campaigns.periodDays', { count: 30 })}</option>
                <option value={90}>{t('campaigns.periodDays', { count: 90 })}</option>
              </select>
            </div>
            {analytics && (analytics.sendsByDay.length > 0 || analytics.repliedByDay.length > 0) ? (
              <CampaignAnalyticsChart analytics={analytics} t={t} />
            ) : (
              <p className="text-sm text-muted-foreground py-4">
                {t('campaigns.analyticsNoData', 'Нет данных за выбранный период. Отправки и ответы появятся после запуска кампании.')}
              </p>
            )}
          </div>
          <div className="rounded-xl border border-border bg-card p-6">
            <h3 className="font-heading text-lg font-semibold text-foreground mb-2">
              {t('campaigns.sequence')}
            </h3>
            <p className="text-sm text-muted-foreground">
              {campaign.sequences?.length
                ? t('campaigns.sequenceBuilderDesc')
                : t('campaigns.noCampaignsDesc')}
            </p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => setTab('sequence')}
            >
              {campaign.sequences?.length
                ? t('campaigns.editStep')
                : t('campaigns.addStep')}
            </Button>
          </div>
        </div>
      )}

      {tab === 'participants' && (
        <CampaignParticipantsTable
          campaignId={id}
          campaign={campaign}
          isActive={isActive}
          onRefresh={load}
        />
      )}

      {tab === 'audience' && (
        <CampaignAudienceSchedule campaignId={id} campaign={campaign} onUpdate={load} />
      )}

      {tab === 'sequence' && (
        <SequenceBuilderCanvas
          campaignId={id}
          campaignStatus={campaign.status}
          templates={campaign.templates || []}
          sequences={campaign.sequences || []}
          onUpdate={load}
        />
      )}

      <Modal
        isOpen={showPreLaunchModal}
        onClose={handlePreLaunchClose}
        title={t('campaigns.preLaunchTitle')}
        size="lg"
      >
        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-muted-foreground">{t('campaigns.preLaunchIntro')}</p>
          <ol className="list-decimal list-inside space-y-2 text-sm text-foreground">
            <li>{t('campaigns.preLaunch1')}</li>
            <li>{t('campaigns.preLaunch2')}</li>
            <li>{t('campaigns.preLaunch3')}</li>
            <li>{t('campaigns.preLaunch4')}</li>
            <li>{t('campaigns.preLaunch5')}</li>
          </ol>
          <div className="flex justify-end pt-2">
            <Button onClick={handlePreLaunchClose}>{t('campaigns.preLaunchGotIt')}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
