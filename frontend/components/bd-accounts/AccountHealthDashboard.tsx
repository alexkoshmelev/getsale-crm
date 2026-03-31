'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { getBdAccountHealthSummary, type BdAccountHealthSummary, type BdHealthRiskRow } from '@/lib/api/bd-accounts';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Loader2, AlertTriangle, Flame, Send, Gauge, ExternalLink } from 'lucide-react';
import { reportError } from '@/lib/error-reporter';
import { clsx } from 'clsx';

function riskRowDisplayName(r: BdHealthRiskRow): string {
  if (r.display_name?.trim()) return r.display_name.trim();
  const n = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
  if (n) return n;
  if (r.username?.trim()) return `@${r.username.trim()}`;
  return r.telegram_id?.trim() || r.id;
}

function serverRiskFlags(r: BdHealthRiskRow): string[] {
  const keys: string[] = [];
  const now = new Date();
  if (r.flood_wait_until) {
    const d = new Date(r.flood_wait_until);
    if (!Number.isNaN(d.getTime()) && d > now) keys.push('flood');
  }
  const conn = r.connection_state;
  if (conn && conn !== 'connected') keys.push(`connection_${conn}`);
  if (r.sync_error?.trim()) keys.push('sync');
  const lm = (r.last_status_message || '').toLowerCase();
  if (r.last_status === 'error' && /proxy|socks|connection refused/.test(lm)) keys.push('proxy');
  return keys;
}

export function AccountHealthDashboard() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<BdAccountHealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await getBdAccountHealthSummary();
      setSummary(s);
    } catch (e) {
      reportError(e, { component: 'AccountHealthDashboard', action: 'load' });
      setError(t('bdAccountHealth.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[240px]">
        <Loader2 className="w-10 h-10 animate-spin text-primary" aria-hidden />
      </div>
    );
  }

  if (error || !summary) {
    return (
      <Card className="p-6">
        <p className="text-red-600 dark:text-red-400 text-sm">{error ?? t('bdAccountHealth.loadError')}</p>
        <Button className="mt-4" variant="secondary" onClick={() => void load()}>
          {t('bdAccountHealth.retry')}
        </Button>
      </Card>
    );
  }

  const statCards = [
    {
      key: 'flood',
      icon: AlertTriangle,
      value: summary.floodActiveCount,
      label: t('bdAccountHealth.cardFlood'),
      href: null as string | null,
      tone: summary.floodActiveCount > 0 ? 'warn' : 'muted',
    },
    {
      key: 'limits',
      icon: Gauge,
      value: summary.limitsConfiguredCount,
      label: t('bdAccountHealth.cardLimits'),
      href: '/dashboard/bd-accounts' as string | null,
      tone: 'muted',
    },
    {
      key: 'warming',
      icon: Flame,
      value: summary.warmingRunningGroups,
      label: t('bdAccountHealth.cardWarming'),
      href: '/dashboard/bd-accounts' as string | null,
      tone: summary.warmingRunningGroups > 0 ? 'accent' : 'muted',
    },
    {
      key: 'campaigns',
      icon: Send,
      value: summary.campaigns.active,
      label: t('bdAccountHealth.cardCampaignsActive'),
      sub:
        summary.campaigns.paused > 0
          ? t('bdAccountHealth.cardCampaignsPaused', { count: summary.campaigns.paused })
          : undefined,
      href: '/dashboard/campaigns',
      tone: 'muted',
    },
  ];

  const risks = summary.riskAccounts ?? [];

  return (
    <div className="space-y-8">
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {t('bdAccountHealth.serverNote', { time: new Date(summary.generatedAt).toLocaleString() })}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {statCards.map((c) => {
          const Icon = c.icon;
          const inner = (
            <Card
              className={clsx(
                'p-4 h-full transition-colors',
                c.tone === 'warn' && 'border-orange-300/80 dark:border-orange-800/60 bg-orange-50/40 dark:bg-orange-950/20',
                c.tone === 'accent' && 'border-primary/30 bg-primary/5'
              )}
            >
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-gray-100 dark:bg-gray-800 p-2">
                  <Icon className="w-5 h-5 text-gray-900 dark:text-gray-100" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-2xl font-semibold tabular-nums text-gray-900 dark:text-white">{c.value}</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">{c.label}</p>
                  {'sub' in c && c.sub ? <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">{c.sub}</p> : null}
                </div>
              </div>
              {c.href ? (
                <Link
                  href={c.href}
                  className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  {t('bdAccountHealth.open')}
                  <ExternalLink className="w-3.5 h-3.5" />
                </Link>
              ) : null}
            </Card>
          );
          return <div key={c.key}>{inner}</div>;
        })}
      </div>

      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">{t('bdAccountHealth.riskTitle')}</h2>
        {risks.length === 0 ? (
          <Card className="p-6 text-sm text-gray-600 dark:text-gray-400">{t('bdAccountHealth.riskEmpty')}</Card>
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {risks.map((a) => {
                const flags = serverRiskFlags(a);
                return (
                  <li key={a.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <Link
                        href={`/dashboard/bd-accounts/${a.id}`}
                        className="font-medium text-gray-900 dark:text-white hover:text-primary"
                      >
                        {riskRowDisplayName(a)}
                      </Link>
                      <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                        {flags.length > 0
                          ? flags.map((f) => t(`bdAccountHealth.riskFlag.${f}`)).join(' · ')
                          : t('bdAccountHealth.riskFlagUnknown')}
                      </p>
                    </div>
                    <Link
                      href={`/dashboard/bd-accounts/${a.id}`}
                      className="inline-flex items-center justify-center font-medium rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-900 dark:text-white px-3 py-1.5 text-sm shrink-0 self-start sm:self-center"
                    >
                      {t('bdAccountHealth.viewAccount')}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
