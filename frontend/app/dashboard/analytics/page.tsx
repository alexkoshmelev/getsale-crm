'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { BarChart3, TrendingUp, Users, DollarSign } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import Button from '@/components/ui/Button';
import { apiClient } from '@/lib/api/client';

type PeriodKey = 'today' | 'week' | 'month' | 'year';

interface Summary {
  total_pipeline_value: number;
  revenue_in_period: number;
  leads_closed_in_period: number;
  participants_count: number;
  leads_created_in_period?: number;
  start_date: string;
  end_date: string;
}

interface TeamMemberRow {
  user_id: string;
  user_email: string;
  user_display_name: string;
  leads_closed: number;
  revenue: string;
  avg_lead_value: string | null;
  avg_days_to_close: string | null;
}

const PERIODS: PeriodKey[] = ['today', 'week', 'month', 'year'];

export default function AnalyticsPage() {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pipelineValue, setPipelineValue] = useState<any[]>([]);
  const [teamPerformance, setTeamPerformance] = useState<TeamMemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<'revenue' | 'leads_closed' | 'avg_lead_value'>('revenue');

  const fetchAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryRes, pipelineRes, teamRes] = await Promise.all([
        apiClient.get<Summary>('/api/analytics/summary', { params: { period } }).catch(() => ({ data: null })),
        apiClient.get('/api/analytics/pipeline-value').catch(() => ({ data: [] })),
        apiClient.get<TeamMemberRow[]>('/api/analytics/team-performance', { params: { period } }).catch(() => ({ data: [] })),
      ]);
      setSummary(summaryRes.data);
      setPipelineValue(Array.isArray(pipelineRes.data) ? pipelineRes.data : []);
      setTeamPerformance(Array.isArray(teamRes.data) ? teamRes.data : []);
    } catch (error) {
      console.error('Error fetching analytics:', error);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  if (loading && !summary && pipelineValue.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[320px]">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" aria-hidden />
      </div>
    );
  }

  const totalValue = pipelineValue.reduce((sum, stage) => sum + (parseFloat(stage.total_value) || 0), 0);
  const hasNoData = pipelineValue.length === 0 && (!summary || (summary.revenue_in_period === 0 && summary.leads_closed_in_period === 0));

  if (hasNoData && teamPerformance.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight mb-1">
            {t('analytics.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('analytics.subtitle')}</p>
        </div>
        <div className="flex-1 flex items-center justify-center py-16">
          <EmptyState
            icon={BarChart3}
            title={t('analytics.emptyTitle')}
            description={t('analytics.emptyDesc')}
            action={
              <div className="flex flex-wrap gap-2 justify-center">
                <Link href="/dashboard/crm">
                  <Button>{t('analytics.emptyCta')}</Button>
                </Link>
                <Link href="/dashboard/pipeline">
                  <Button variant="outline">{t('analytics.emptyCtaPipeline')}</Button>
                </Link>
              </div>
            }
          />
        </div>
      </div>
    );
  }

  const totalPipelineValue = summary?.total_pipeline_value ?? totalValue;
  const revenueInPeriod = summary?.revenue_in_period ?? 0;
  const leadsClosedInPeriod = summary?.leads_closed_in_period ?? 0;
  const leadsCreatedInPeriod = summary?.leads_created_in_period ?? 0;
  const participantsCount = summary?.participants_count ?? teamPerformance.length;

  const totalRevenue = teamPerformance.reduce((s, m) => s + parseFloat(m.revenue || '0'), 0);
  const sortedTeam = [...teamPerformance].sort((a, b) => {
    switch (sortBy) {
      case 'leads_closed':
        return (b.leads_closed ?? 0) - (a.leads_closed ?? 0);
      case 'avg_lead_value':
        return (parseFloat(b.avg_lead_value || '0') || 0) - (parseFloat(a.avg_lead_value || '0') || 0);
      default:
        return parseFloat(b.revenue || '0') - parseFloat(a.revenue || '0');
    }
  });

  const statCards = [
    { key: 'totalValue', value: `$${totalPipelineValue.toLocaleString()}`, icon: DollarSign },
    { key: 'revenueInPeriod', value: `$${revenueInPeriod.toLocaleString()}`, icon: DollarSign },
    { key: 'leadsClosedInPeriod', value: String(leadsClosedInPeriod), icon: TrendingUp },
    { key: 'leadsCreatedInPeriod', value: String(leadsCreatedInPeriod), icon: TrendingUp },
    { key: 'participants', value: String(participantsCount), icon: Users },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight mb-1">
            {t('analytics.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('analytics.subtitle')}</p>
        </div>
        <div className="flex rounded-lg border border-border bg-muted/30 p-1">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                period === p
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(`analytics.period${p.charAt(0).toUpperCase() + p.slice(1)}` as const)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.key} className="border-l-4 border-l-primary">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">{t(`analytics.${stat.key}`)}</p>
                  <p className="font-heading text-2xl font-bold text-foreground mt-1 tracking-tight">{stat.value}</p>
                </div>
                <div className="p-3 rounded-xl bg-primary/10 text-primary">
                  <Icon className="w-5 h-5" />
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card title={t('analytics.valueByStage')}>
        <div className="space-y-4">
          {pipelineValue.map((stage) => (
            <div key={stage.stage_name}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-foreground">{stage.stage_name}</span>
                <span className="text-sm font-semibold text-foreground">
                  ${(parseFloat(stage.total_value) || 0).toLocaleString()}
                </span>
              </div>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{
                    width: totalValue ? `${((parseFloat(stage.total_value) || 0) / totalValue) * 100}%` : '0%',
                  }}
                />
              </div>
              <div className="flex items-center justify-between mt-1 text-xs text-muted-foreground">
                <span>{t('analytics.leadsCount', { count: stage.lead_count ?? stage.deal_count ?? 0 })}</span>
                <span>{t('analytics.average')}: ${(parseFloat(stage.avg_value) || 0).toLocaleString()}</span>
              </div>
            </div>
          ))}
          {pipelineValue.length === 0 && (
            <p className="text-muted-foreground text-center py-8 text-sm">{t('analytics.noData')}</p>
          )}
        </div>
      </Card>

      <Card title={t('analytics.teamPerformance')}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('analytics.member')}
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-foreground"
                  onClick={() => setSortBy('leads_closed')}
                >
                  {t('analytics.leadsClosed')}
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-foreground"
                  onClick={() => setSortBy('revenue')}
                >
                  {t('analytics.revenue')}
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-foreground"
                  onClick={() => setSortBy('avg_lead_value')}
                >
                  {t('analytics.avgLead')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('analytics.avgTime')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('analytics.percentOfRevenue')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedTeam.map((member) => {
                const rev = parseFloat(member.revenue || '0');
                const pct = totalRevenue > 0 ? (rev / totalRevenue) * 100 : 0;
                return (
                  <tr key={member.user_id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-sm font-medium text-foreground">
                      {member.user_display_name || member.user_email || member.user_id}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{member.leads_closed}</td>
                    <td className="px-4 py-3 text-sm font-medium text-foreground">
                      ${rev.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {member.avg_lead_value != null
                        ? `$${parseFloat(member.avg_lead_value).toLocaleString()}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {member.avg_days_to_close != null
                        ? `${Math.round(parseFloat(member.avg_days_to_close))} ${t('analytics.days')}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {totalRevenue > 0 ? `${pct.toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sortedTeam.length === 0 && (
            <p className="text-muted-foreground text-center py-8 text-sm">{t('analytics.noDataForPeriod')}</p>
          )}
        </div>
      </Card>
    </div>
  );
}
