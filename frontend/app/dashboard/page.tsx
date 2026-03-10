'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { Building2, Users, MessageSquare, TrendingUp, ArrowRight, Bell } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import { apiClient } from '@/lib/api/client';
import { fetchUpcomingReminders, type Reminder } from '@/lib/api/crm';

interface ActivityItem {
  id: string;
  user_id: string;
  user_email: string;
  user_display_name: string;
  action_type: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const ACTION_TYPE_KEYS: Record<string, string> = {
  'lead.created': 'activityLeadCreated',
  'lead.stage_changed': 'activityLeadStageChanged',
  'campaign.started': 'activityCampaignStarted',
  'campaign.created': 'activityCampaignCreated',
  'team.member.added': 'activityTeamMemberAdded',
  'team.member.removed': 'activityTeamMemberRemoved',
  'bd_account.connected': 'activityBdAccountConnected',
  'company.created': 'activityCompanyCreated',
  'contact.created': 'activityContactCreated',
  'deal.created': 'activityDealCreated',
  'lead.converted': 'activityLeadConverted',
  'discovery.started': 'activityDiscoveryStarted',
};

function getActivityLabel(actionType: string, t: (key: string) => string): string {
  const key = ACTION_TYPE_KEYS[actionType];
  return key ? t(`dashboard.${key}`) : actionType;
}

function getInitials(name: string, email: string): string {
  const trimmed = name.trim();
  if (trimmed) {
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    if (parts[0].length >= 1) return parts[0].slice(0, 2).toUpperCase();
  }
  if (email && email.includes('@')) return email.slice(0, 2).toUpperCase();
  return '?';
}

const ACTIVITY_FEED_LIMIT = 50;

const statCardsConfig = [
  { titleKey: 'companies', icon: Building2, href: '/dashboard/crm' },
  { titleKey: 'contacts', icon: Users, href: '/dashboard/crm' },
  { titleKey: 'messages', icon: MessageSquare, href: '/dashboard/messaging' },
  { titleKey: 'leads', icon: TrendingUp, href: '/dashboard/pipeline' },
];

export default function DashboardPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState({
    companies: 0,
    contacts: 0,
    messages: 0,
    leads: 0,
  });
  const [loading, setLoading] = useState(true);
  const [upcomingReminders, setUpcomingReminders] = useState<Reminder[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const [companiesRes, contactsRes, messagesRes, pipelinesRes] = await Promise.all([
          apiClient.get('/api/crm/companies').catch(() => ({ data: [] })),
          apiClient.get('/api/crm/contacts').catch(() => ({ data: [] })),
          apiClient.get('/api/messaging/inbox').catch(() => ({ data: [] })),
          apiClient.get('/api/pipeline').catch(() => ({ data: [] })),
        ]);
        const pipelines = Array.isArray(pipelinesRes.data) ? pipelinesRes.data : [];
        const defaultPipeline = pipelines.find((p: { is_default?: boolean }) => p.is_default) || pipelines[0];
        let leadsTotal = 0;
        if (defaultPipeline?.id) {
          const leadsRes = await apiClient.get('/api/pipeline/leads', { params: { pipelineId: defaultPipeline.id, limit: 1 } }).catch(() => ({ data: { pagination: { total: 0 } } }));
          leadsTotal = leadsRes.data?.pagination?.total ?? 0;
        }

        setStats({
          companies: companiesRes.data.length || 0,
          contacts: contactsRes.data.length || 0,
          messages: messagesRes.data.length || 0,
          leads: leadsTotal,
        });
      } catch (error) {
        console.error('Error fetching stats:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, []);

  useEffect(() => {
    fetchUpcomingReminders({ hours: 72, limit: 10 })
      .then(setUpcomingReminders)
      .catch(() => setUpcomingReminders([]));
  }, []);

  useEffect(() => {
    apiClient
      .get<ActivityItem[]>('/api/activity', { params: { limit: ACTIVITY_FEED_LIMIT } })
      .then((res) => setActivity(Array.isArray(res.data) ? res.data : []))
      .catch(() => setActivity([]));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[320px]">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" aria-hidden />
      </div>
    );
  }

  const values = [stats.companies, stats.contacts, stats.messages, stats.leads];

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0">
        <h1 className="font-heading text-3xl font-bold text-foreground tracking-tight mb-1.5">
          {t('dashboard.title')}
        </h1>
        <p className="text-muted-foreground text-base">
          {t('dashboard.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 shrink-0 mt-8">
        {statCardsConfig.map((stat, i) => {
          const Icon = stat.icon;
          const value = values[i];
          return (
            <Link key={stat.titleKey} href={stat.href} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-xl">
              <Card
                className="group cursor-pointer border-l-4 border-l-primary hover:shadow-soft-md hover:-translate-y-0.5 transition-all duration-200"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">
                      {t(`dashboard.${stat.titleKey}`)}
                    </p>
                    <p className="font-heading text-2xl font-bold text-foreground mt-1 tracking-tight">
                      {value}
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-primary/10 text-primary transition-transform duration-200 group-hover:scale-105">
                    <Icon className="w-5 h-5" />
                  </div>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 flex flex-col mt-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 min-h-0 flex-1">
          {upcomingReminders.length > 0 && (
            <Card title={t('dashboard.upcomingReminders', 'Предстоящие напоминания')} className="flex flex-col min-h-0">
              <ul className="space-y-2 flex-1 min-h-0">
                {upcomingReminders.slice(0, 8).map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                    <Link
                      href={r.entity_type === 'contact' ? `/dashboard/crm?tab=contacts&open=${r.entity_id}` : `/dashboard/pipeline`}
                      className="text-primary hover:underline truncate flex-1 min-w-0"
                    >
                      {r.title || new Date(r.remind_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                    </Link>
                    <span className="text-muted-foreground shrink-0">
                      {new Date(r.remind_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </li>
                ))}
              </ul>
              <Link href="/dashboard/crm" className="text-sm text-primary hover:underline mt-2 flex items-center gap-1">
                {t('dashboard.allReminders', 'Все напоминания в CRM')}
                <ArrowRight className="w-3 h-3" />
              </Link>
            </Card>
          )}

          <div className={`flex gap-6 flex-1 min-h-0 ${upcomingReminders.length === 0 ? 'lg:col-span-2' : ''}`}>
            <Card title={t('dashboard.recentActivity')} className="flex flex-col flex-1 min-h-0">
              <div className="flex-1 min-h-0 overflow-y-auto -m-1 p-1">
                {activity.length === 0 ? (
                  <p className="text-muted-foreground text-sm leading-relaxed py-2">
                    {t('dashboard.recentActivityPlaceholder')}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {activity.map((item) => (
                      <li key={item.id} className="flex items-start gap-3 py-2 px-1 rounded-lg hover:bg-muted/50 transition-colors">
                        <span
                          className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-medium"
                          aria-hidden
                        >
                          {getInitials(item.user_display_name, item.user_email)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-foreground">
                            <span className="font-medium">{item.user_display_name}</span>
                            {' '}
                            <span className="text-muted-foreground">{getActivityLabel(item.action_type, t)}</span>
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {new Date(item.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>

            <Card title={t('dashboard.quickActions')} className="shrink-0 w-72">
              <div className="space-y-2">
                <Link href="/dashboard/crm" className="block">
                  <Button variant="secondary" className="w-full justify-start gap-2 h-11">
                    <Building2 className="w-4 h-4" />
                    {t('dashboard.createCompany')}
                    <ArrowRight className="w-4 h-4 ml-auto opacity-50" />
                  </Button>
                </Link>
                <Link href="/dashboard/crm" className="block">
                  <Button variant="secondary" className="w-full justify-start gap-2 h-11">
                    <Users className="w-4 h-4" />
                    {t('dashboard.addContact')}
                    <ArrowRight className="w-4 h-4 ml-auto opacity-50" />
                  </Button>
                </Link>
                <Link href="/dashboard/pipeline" className="block">
                  <Button variant="secondary" className="w-full justify-start gap-2 h-11">
                    <TrendingUp className="w-4 h-4" />
                    {t('dashboard.newLead')}
                    <ArrowRight className="w-4 h-4 ml-auto opacity-50" />
                  </Button>
                </Link>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

