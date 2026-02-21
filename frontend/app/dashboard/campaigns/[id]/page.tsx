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
} from 'lucide-react';
import Button from '@/components/ui/Button';
import {
  fetchCampaign,
  fetchCampaignStats,
  fetchCampaignAnalytics,
  startCampaign,
  pauseCampaign,
  updateCampaign,
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
} from 'recharts';

const PRELAUNCH_SEEN_KEY = 'getsale-campaign-prelaunch-seen';

type Tab = 'overview' | 'participants' | 'sequence' | 'audience';

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
  const chartData = sortedDates.map((date) => ({
    date: new Date(date).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }),
    fullDate: date,
    sends: sendsMap.get(date) ?? 0,
    replied: repliedMap.get(date) ?? 0,
  }));

  if (chartData.length === 0) return null;

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis dataKey="date" tick={{ fontSize: 12 }} className="text-muted-foreground" />
          <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
          <Tooltip
            contentStyle={{ borderRadius: 8, border: '1px solid var(--border)' }}
            labelFormatter={(_, payload) => payload?.[0]?.payload?.fullDate}
            formatter={(value: number, name: string) => [
              value,
              name === 'sends' ? t('campaigns.sent') : t('campaigns.replied'),
            ]}
          />
          <Legend
            formatter={(value) => (value === 'sends' ? t('campaigns.sent') : t('campaigns.replied'))}
          />
          <Bar dataKey="sends" fill="hsl(var(--primary))" name="sends" radius={[4, 4, 0, 0]} />
          <Bar dataKey="replied" fill="hsl(142.1 76.2% 36.3%)" name="replied" radius={[4, 4, 0, 0]} />
        </BarChart>
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
    if (!id) return;
    setActionLoading(true);
    try {
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
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
                <div className="rounded-xl border border-border bg-card p-4 flex items-start gap-3">
                  <div className="rounded-lg bg-muted p-2">
                    <Users className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground mb-0.5">{t('campaigns.totalParticipants')}</p>
                    <p className="text-2xl font-semibold text-foreground">{stats.total}</p>
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4 flex items-start gap-3">
                  <div className="rounded-lg bg-sky-500/10 p-2">
                    <Clock className="w-5 h-5 text-sky-600 dark:text-sky-400" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground mb-0.5">{t('campaigns.statusPending')}</p>
                    <p className="text-2xl font-semibold text-foreground">{stats.byStatus?.pending ?? 0}</p>
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4 flex items-start gap-3">
                  <div className="rounded-lg bg-blue-500/10 p-2">
                    <SendHorizontal className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground mb-0.5">{t('campaigns.sent')}</p>
                    <p className="text-2xl font-semibold text-foreground">
                      {stats.byStatus?.sent ?? 0}
                      {stats.total ? ` (${Math.round(((stats.byStatus?.sent ?? 0) / stats.total) * 100)}%)` : ''}
                    </p>
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4 flex items-start gap-3">
                  <div className="rounded-lg bg-emerald-500/10 p-2">
                    <MessageCircle className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground mb-0.5">{t('campaigns.replied')}</p>
                    <p className="text-2xl font-semibold text-foreground">
                      {stats.byStatus?.replied ?? 0}
                      {stats.total ? ` (${Math.round(((stats.byStatus?.replied ?? 0) / stats.total) * 100)}%)` : ''}
                    </p>
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4 flex items-start gap-3">
                  <div className="rounded-lg bg-amber-500/10 p-2">
                    <UserX className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground mb-0.5">{t('campaigns.stopped')}</p>
                    <p className="text-2xl font-semibold text-foreground">{stats.byStatus?.stopped ?? 0}</p>
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4 flex items-start gap-3">
                  <div className="rounded-lg bg-muted p-2">
                    <BarChart3 className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground mb-0.5">{t('campaigns.statusCompleted', 'Завершено')}</p>
                    <p className="text-2xl font-semibold text-foreground">{stats.byStatus?.completed ?? 0}</p>
                  </div>
                </div>
              </div>
            </>
          )}
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
