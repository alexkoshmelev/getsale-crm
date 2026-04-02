'use client';

import { useEffect, useState, useRef } from 'react';
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
  UserPlus,
  History,
  Pencil,
  Trash2,
  Copy,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { reportError, reportWarning } from '@/lib/error-reporter';
import {
  fetchCampaign,
  fetchCampaignStats,
  fetchCampaignAnalytics,
  startCampaign,
  pauseCampaign,
  updateCampaign,
  addCampaignParticipants,
  fetchCampaignSends,
  deleteCampaign,
  duplicateCampaign,
  checkCampaignAudienceConflicts,
  enrichContactsFromTelegram,
  type CampaignWithDetails,
  type CampaignStats,
  type CampaignAnalytics,
  type CampaignSendsPage,
} from '@/lib/api/campaigns';
import { postSpamBotCheck } from '@/lib/api/bd-accounts';
import { useAuthStore } from '@/lib/stores/auth-store';
import { canManageCampaignLifecycle } from '@/lib/permissions';
import { SequenceBuilderCanvas } from '@/components/campaigns/SequenceBuilderCanvas';
import { CampaignAudienceSchedule } from '@/components/campaigns/CampaignAudienceSchedule';
import { CampaignSendingAccountsOverview } from '@/components/campaigns/CampaignSendingAccountsOverview';
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
import { safeGetItem, safeSetItem } from '@/lib/safe-storage';

const PRELAUNCH_SEEN_KEY = 'getsale-campaign-prelaunch-seen';

type Tab = 'overview' | 'participants' | 'sequence' | 'audience' | 'sends';

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
  const rawId = params?.id;
  const id = (Array.isArray(rawId) ? rawId[0] : rawId) ?? '';
  const tabFromUrl = (searchParams?.get('tab') || 'overview') as Tab;
  const [tab, setTab] = useState<Tab>(
    ['overview', 'sequence', 'audience', 'participants', 'sends'].includes(tabFromUrl) ? tabFromUrl : 'overview'
  );
  const [campaign, setCampaign] = useState<CampaignWithDetails | null>(null);
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [analytics, setAnalytics] = useState<CampaignAnalytics | null>(null);
  const [analyticsDays, setAnalyticsDays] = useState(14);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [showPreLaunchModal, setShowPreLaunchModal] = useState(false);
  const [pendingStartAfterModal, setPendingStartAfterModal] = useState(false);
  const [showAddParticipantsModal, setShowAddParticipantsModal] = useState(false);
  const [addParticipantIdsText, setAddParticipantIdsText] = useState('');
  const [addParticipantsLoading, setAddParticipantsLoading] = useState(false);
  const [sendsPage, setSendsPage] = useState(1);
  const [sendsData, setSendsData] = useState<CampaignSendsPage | null>(null);
  const [sendsLoading, setSendsLoading] = useState(false);
  const user = useAuthStore((s) => s.user);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const campaignRef = useRef<CampaignWithDetails | null>(null);
  campaignRef.current = campaign ?? null;

  const canLifecycle =
    campaign != null && canManageCampaignLifecycle(user?.role, user?.id, campaign.created_by_user_id);

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
      reportError(e, { component: 'CampaignPage', action: 'loadCampaign' });
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
      reportError(e, { component: 'CampaignPage', action: 'loadCampaignAnalytics' });
      setAnalytics(null);
    }
  };

  useEffect(() => {
    if (id && tab === 'overview') loadAnalytics();
  }, [id, tab, analyticsDays]);

  useEffect(() => {
    const tabParam = searchParams?.get('tab');
    if (
      tabParam === 'sequence' ||
      tabParam === 'overview' ||
      tabParam === 'audience' ||
      tabParam === 'participants' ||
      tabParam === 'sends'
    )
      setTab(tabParam);
  }, [searchParams]);

  const loadSends = async () => {
    if (!id) return;
    setSendsLoading(true);
    try {
      const d = await fetchCampaignSends(id, { page: sendsPage, limit: 40 });
      setSendsData(d);
    } catch (e) {
      reportError(e, { component: 'CampaignPage', action: 'loadSends' });
      setSendsData(null);
    } finally {
      setSendsLoading(false);
    }
  };

  useEffect(() => {
    if (id && tab === 'sends') loadSends();
  }, [id, tab, sendsPage]);

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
          await enrichContactsFromTelegram(contactIds, aud.bdAccountIds?.[0] ?? aud.bdAccountId);
        } catch (e) {
          reportWarning('Enrich contacts before start failed', { component: 'CampaignPage', error: e });
        }
      }
      await startCampaign(id);
      load();
    } catch (e) {
      reportError(e, { component: 'CampaignPage', action: 'startCampaign' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleStart = () => {
    if (!id) return;
    if (!safeGetItem(PRELAUNCH_SEEN_KEY)) {
      setPendingStartAfterModal(true);
      setShowPreLaunchModal(true);
      return;
    }
    doStart();
  };

  const handlePreLaunchClose = () => {
    if (pendingStartAfterModal) {
      safeSetItem(PRELAUNCH_SEEN_KEY, '1');
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
      reportError(e, { component: 'CampaignPage', action: 'pauseCampaign' });
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
      reportError(e, { component: 'CampaignPage', action: 'stopCampaign' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveName = async () => {
    if (!id || !campaign) return;
    const nm = nameDraft.trim();
    if (!nm) return;
    if (nm === campaign.name) {
      setEditingName(false);
      return;
    }
    setActionLoading(true);
    try {
      await updateCampaign(id, { name: nm });
      setEditingName(false);
      await load();
    } catch (e) {
      reportError(e, { component: 'CampaignPage', action: 'renameCampaign' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleDuplicateCampaign = async () => {
    if (!id || !confirm(t('campaigns.duplicateCampaignConfirm'))) return;
    setActionLoading(true);
    try {
      const created = await duplicateCampaign(id);
      window.location.href = `/dashboard/campaigns/${created.id}`;
    } catch (e) {
      reportError(e, { component: 'CampaignPage', action: 'duplicateCampaign' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteCampaign = async () => {
    if (!id || !campaign) return;
    if (!confirm(t('campaigns.deleteCampaignConfirm', { name: campaign.name }))) return;
    setActionLoading(true);
    try {
      await deleteCampaign(id);
      window.location.href = '/dashboard/campaigns';
    } catch (e) {
      reportError(e, { component: 'CampaignPage', action: 'deleteCampaign' });
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
  const canAddParticipants =
    campaign.status === 'draft' ||
    campaign.status === 'paused' ||
    campaign.status === 'active' ||
    campaign.status === 'completed';

  const submitAddParticipants = async () => {
    if (!id) return;
    const raw = addParticipantIdsText
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const ids = [...new Set(raw)];
    if (ids.length === 0) return;
    setAddParticipantsLoading(true);
    try {
      const { conflicts } = await checkCampaignAudienceConflicts(id, ids);
      const risky = conflicts.filter((c) => !c.is_current_campaign || c.last_sent_at != null);
      if (risky.length > 0) {
        const ok = window.confirm(t('campaigns.audienceConflictsHint'));
        if (!ok) {
          setAddParticipantsLoading(false);
          return;
        }
      }
      await addCampaignParticipants(id, ids);
      setShowAddParticipantsModal(false);
      setAddParticipantIdsText('');
      await load();
    } catch (e) {
      reportError(e, { component: 'CampaignPage', action: 'addParticipants' });
    } finally {
      setAddParticipantsLoading(false);
    }
  };

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
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {editingName ? (
                  <>
                    <input
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      className="font-heading text-2xl font-bold text-foreground tracking-tight max-w-full min-w-[200px] px-2 py-1 rounded-lg border border-border bg-background"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleSaveName();
                        if (e.key === 'Escape') setEditingName(false);
                      }}
                    />
                    <Button size="sm" onClick={() => void handleSaveName()} disabled={actionLoading || !nameDraft.trim()}>
                      {t('campaigns.renameCampaignSave')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditingName(false)} disabled={actionLoading}>
                      {t('common.cancel')}
                    </Button>
                  </>
                ) : (
                  <>
                    <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight truncate">
                      {campaign.name}
                    </h1>
                    {canLifecycle && (
                      <button
                        type="button"
                        onClick={() => {
                          setNameDraft(campaign.name);
                          setEditingName(true);
                        }}
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
                        aria-label={t('campaigns.renameCampaign')}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    )}
                  </>
                )}
              </div>
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
            {canLifecycle && (
              <>
                <Button variant="outline" onClick={() => void handleDuplicateCampaign()} disabled={actionLoading}>
                  <Copy className="w-4 h-4 mr-2" />
                  {t('campaigns.duplicateCampaign')}
                </Button>
                {campaign.status !== 'active' && (
                  <Button
                    variant="outline"
                    className="text-destructive border-destructive/30 hover:bg-destructive/10"
                    onClick={() => void handleDeleteCampaign()}
                    disabled={actionLoading}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    {t('campaigns.deleteCampaign')}
                  </Button>
                )}
              </>
            )}
            {canAddParticipants && (
              <Button variant="outline" onClick={() => setShowAddParticipantsModal(true)} disabled={actionLoading}>
                <UserPlus className="w-4 h-4 mr-2" />
                {t('campaigns.addParticipants', { defaultValue: 'Add participants' })}
              </Button>
            )}
            {canStart && (
              <Button onClick={handleStart} disabled={actionLoading}>
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                {campaign.status === 'draft' ? t('campaigns.startCampaign') : t('campaigns.resumeCampaign')}
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
        <button
          type="button"
          onClick={() => setTab('sends')}
          className={clsx(
            'px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors',
            tab === 'sends'
              ? 'bg-card text-foreground border border-border border-b-0 -mb-px'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            <History className="w-3.5 h-3.5" />
            {t('campaigns.sendHistory', { defaultValue: 'Send history' })}
          </span>
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

          {campaign?.bd_accounts &&
            campaign.bd_accounts.some((a) => a.spamRestrictedAt) && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-900 dark:text-red-100">
                <p className="font-medium">{t('campaigns.spamBotBanner')}</p>
                <div className="mt-2 flex flex-wrap gap-2 items-center">
                  {campaign.bd_accounts
                    .filter((a) => a.spamRestrictedAt)
                    .map((a) => (
                      <Button
                        key={a.id}
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void postSpamBotCheck(a.id).then(() => load())}
                      >
                        {t('campaigns.spamBotRecheckNamed', { name: a.displayName })}
                      </Button>
                    ))}
                  <Link
                    href={`/dashboard/bd-accounts/${campaign.bd_accounts.find((a) => a.spamRestrictedAt)?.id ?? ''}`}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    {t('campaigns.spamBotGoToAccount')}
                  </Link>
                </div>
              </div>
            )}

          {campaign?.bd_accounts && campaign.bd_accounts.length > 0 && (
            <CampaignSendingAccountsOverview
              accounts={campaign.bd_accounts}
              campaignId={id}
              onChanged={() => void load()}
            />
          )}

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

              {(campaign?.status === 'active' && (stats.byStatus?.failed ?? 0) > 0) && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
                  {t('campaigns.deliveryErrorsBanner', { count: stats.byStatus.failed })}
                  {stats.error_summary?.sample && (
                    <p className="mt-2 font-medium text-amber-900 dark:text-amber-100">{stats.error_summary.sample}</p>
                  )}
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
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
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
          onRemoveContact={
            id && (campaign?.status === 'draft' || campaign?.status === 'paused')
              ? async (contactId) => {
                  const c = campaignRef.current;
                  if (!c?.target_audience) return;
                  try {
                    const current = Array.isArray(c.target_audience.contactIds) ? c.target_audience.contactIds : [];
                    const next = current.filter((cid) => cid !== contactId);
                    await updateCampaign(id, {
                      targetAudience: {
                        ...c.target_audience,
                        contactIds: next.length > 0 ? next : [],
                      },
                    });
                    await load();
                  } catch (e) {
                    reportError(e, { component: 'CampaignPage', action: 'removeParticipant' });
                  }
                }
              : undefined
          }
          onRemoveAll={
            id && (campaign?.status === 'draft' || campaign?.status === 'paused') && (campaign.target_audience?.contactIds?.length ?? 0) > 0
              ? async () => {
                  const c = campaignRef.current;
                  if (!c?.target_audience) return;
                  try {
                    await updateCampaign(id, {
                      targetAudience: {
                        ...c.target_audience,
                        contactIds: [],
                      },
                    });
                    await load();
                  } catch (e) {
                    reportError(e, { component: 'CampaignPage', action: 'removeAllParticipants' });
                  }
                }
              : undefined
          }
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

      {tab === 'sends' && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-medium text-foreground">{t('campaigns.sendHistory', { defaultValue: 'Send history' })}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{t('campaigns.sendHistoryChronological')}</p>
            </div>
            {sendsData && (
              <span className="text-xs text-muted-foreground">
                {t('campaigns.sendHistoryTotal', { defaultValue: '{{count}} sends', count: sendsData.pagination.total })}
              </span>
            )}
          </div>
          {sendsLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : sendsData && sendsData.data.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">{t('common.noData')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
                    <th className="p-3 font-medium">{t('campaigns.sentAt', { defaultValue: 'Sent' })}</th>
                    <th className="p-3 font-medium">{t('campaigns.contact', { defaultValue: 'Contact' })}</th>
                    <th className="p-3 font-medium">{t('campaigns.step', { defaultValue: 'Step' })}</th>
                    <th className="p-3 font-medium">{t('campaigns.status', { defaultValue: 'Status' })}</th>
                    <th className="p-3 font-medium">{t('campaigns.message', { defaultValue: 'Message' })}</th>
                    <th className="p-3 font-medium hidden lg:table-cell">{t('campaigns.sendHistoryMeta')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(sendsData?.data ?? []).map((row) => (
                    <tr key={row.sendId} className="border-b border-border/80">
                      <td className="p-3 whitespace-nowrap text-muted-foreground">{formatDateTime(row.sentAt)}</td>
                      <td className="p-3 max-w-[140px] truncate" title={row.contactName}>
                        {row.contactName}
                      </td>
                      <td className="p-3 tabular-nums">{row.sequenceStep + 1}</td>
                      <td className="p-3">
                        <span className="text-xs">{row.status}</span>
                        {row.messageStatus && (
                          <span className="text-xs text-muted-foreground block">{row.messageStatus}</span>
                        )}
                      </td>
                      <td className="p-3 max-w-md truncate text-muted-foreground" title={row.messageContent ?? ''}>
                        {row.messageContent ?? '—'}
                      </td>
                      <td className="p-3 max-w-[200px] text-xs text-muted-foreground hidden lg:table-cell truncate" title={row.metadata ? JSON.stringify(row.metadata) : ''}>
                        {row.metadata && typeof row.metadata === 'object' && row.metadata !== null && 'event' in row.metadata
                          ? String((row.metadata as { event?: string }).event ?? '')
                          : row.metadata
                            ? JSON.stringify(row.metadata).slice(0, 80)
                            : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {sendsData && sendsData.pagination.totalPages > 1 && (
            <div className="p-3 flex justify-center gap-2 border-t border-border">
              <Button
                variant="outline"
                size="sm"
                disabled={sendsPage <= 1}
                onClick={() => setSendsPage((p) => Math.max(1, p - 1))}
              >
                {t('common.prev', { defaultValue: 'Previous' })}
              </Button>
              <span className="text-sm text-muted-foreground self-center px-2">
                {sendsPage} / {sendsData.pagination.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={sendsPage >= sendsData.pagination.totalPages}
                onClick={() => setSendsPage((p) => p + 1)}
              >
                {t('common.next', { defaultValue: 'Next' })}
              </Button>
            </div>
          )}
        </div>
      )}

      <Modal
        isOpen={showAddParticipantsModal}
        onClose={() => !addParticipantsLoading && setShowAddParticipantsModal(false)}
        title={t('campaigns.addParticipantsTitle', { defaultValue: 'Add participants' })}
      >
        <div className="px-6 py-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('campaigns.addParticipantsHint', {
              defaultValue: 'Contact IDs (UUID), one per line or comma-separated. Duplicates are skipped. Completed campaigns become active when new participants are added.',
            })}
          </p>
          <textarea
            value={addParticipantIdsText}
            onChange={(e) => setAddParticipantIdsText(e.target.value)}
            rows={6}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono"
            placeholder="550e8400-e29b-41d4-a716-446655440000"
            disabled={addParticipantsLoading}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowAddParticipantsModal(false)} disabled={addParticipantsLoading}>
              {t('common.cancel')}
            </Button>
            <Button onClick={submitAddParticipants} disabled={addParticipantsLoading || !addParticipantIdsText.trim()}>
              {addParticipantsLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('campaigns.addParticipants', { defaultValue: 'Add participants' })}
            </Button>
          </div>
        </div>
      </Modal>

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
