'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { BarChart3, TrendingUp, Users, DollarSign } from 'lucide-react';
import { Card } from '@/components/ui/Card';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function AnalyticsPage() {
  const { t } = useTranslation();
  const [conversionRates, setConversionRates] = useState<any[]>([]);
  const [pipelineValue, setPipelineValue] = useState<any[]>([]);
  const [teamPerformance, setTeamPerformance] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    try {
      const [conversionRes, pipelineRes, teamRes] = await Promise.all([
        axios.get(`${API_URL}/api/analytics/conversion-rates`).catch(() => ({ data: [] })),
        axios.get(`${API_URL}/api/analytics/pipeline-value`).catch(() => ({ data: [] })),
        axios.get(`${API_URL}/api/analytics/team-performance`).catch(() => ({ data: [] })),
      ]);

      setConversionRates(conversionRes.data);
      setPipelineValue(pipelineRes.data);
      setTeamPerformance(teamRes.data);
    } catch (error) {
      console.error('Error fetching analytics:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[320px]">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" aria-hidden />
      </div>
    );
  }

  const totalValue = pipelineValue.reduce((sum, stage) => sum + (parseFloat(stage.total_value) || 0), 0);

  const statCards = [
    { key: 'totalValue', value: `$${totalValue.toLocaleString()}`, icon: DollarSign, accent: 'success' },
    { key: 'conversions', value: String(conversionRates.length), icon: TrendingUp, accent: 'primary' },
    { key: 'stages', value: String(pipelineValue.length), icon: BarChart3, accent: 'primary' },
    { key: 'participants', value: String(teamPerformance.length), icon: Users, accent: 'primary' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight mb-1">
          {t('analytics.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('analytics.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
                <span>{t('analytics.dealsCount', { count: stage.deal_count })}</span>
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
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('analytics.dealsClosed')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('analytics.revenue')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('analytics.avgTime')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {teamPerformance.map((member) => (
                <tr key={member.user_id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 text-sm font-medium text-foreground">
                    User {member.user_id.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{member.deals_closed}</td>
                  <td className="px-4 py-3 text-sm font-medium text-foreground">
                    ${(parseFloat(member.revenue) || 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {member.avg_days_to_close
                      ? `${Math.round(parseFloat(member.avg_days_to_close))} ${t('analytics.days')}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {teamPerformance.length === 0 && (
            <p className="text-muted-foreground text-center py-8 text-sm">{t('analytics.noPerformance')}</p>
          )}
        </div>
      </Card>
    </div>
  );
}
