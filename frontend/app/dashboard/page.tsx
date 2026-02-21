'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import axios from 'axios';
import { Building2, Users, MessageSquare, TrendingUp, ArrowRight, Bell } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import { fetchUpcomingReminders, type Reminder } from '@/lib/api/crm';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

const statCardsConfig = [
  { titleKey: 'companies', icon: Building2, href: '/dashboard/crm' },
  { titleKey: 'contacts', icon: Users, href: '/dashboard/crm' },
  { titleKey: 'messages', icon: MessageSquare, href: '/dashboard/messaging' },
  { titleKey: 'deals', icon: TrendingUp, href: '/dashboard/pipeline' },
];

export default function DashboardPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState({
    companies: 0,
    contacts: 0,
    messages: 0,
    deals: 0,
  });
  const [loading, setLoading] = useState(true);
  const [upcomingReminders, setUpcomingReminders] = useState<Reminder[]>([]);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const [companiesRes, contactsRes, messagesRes, dealsRes] = await Promise.all([
          axios.get(`${API_URL}/api/crm/companies`).catch(() => ({ data: [] })),
          axios.get(`${API_URL}/api/crm/contacts`).catch(() => ({ data: [] })),
          axios.get(`${API_URL}/api/messaging/inbox`).catch(() => ({ data: [] })),
          axios.get(`${API_URL}/api/crm/deals`).catch(() => ({ data: [] })),
        ]);

        setStats({
          companies: companiesRes.data.length || 0,
          contacts: contactsRes.data.length || 0,
          messages: messagesRes.data.length || 0,
          deals: dealsRes.data.length || 0,
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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[320px]">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" aria-hidden />
      </div>
    );
  }

  const values = [stats.companies, stats.contacts, stats.messages, stats.deals];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-3xl font-bold text-foreground tracking-tight mb-1.5">
          {t('dashboard.title')}
        </h1>
        <p className="text-muted-foreground text-base">
          {t('dashboard.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {upcomingReminders.length > 0 && (
          <Card title={t('dashboard.upcomingReminders', 'Предстоящие напоминания')} className="flex flex-col">
            <ul className="space-y-2 flex-1 min-h-0">
              {upcomingReminders.slice(0, 8).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                  <Link
                    href={r.entity_type === 'contact' ? `/dashboard/crm?tab=contacts&open=${r.entity_id}` : `/dashboard/crm?tab=deals&open=${r.entity_id}`}
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

        <Card title={t('dashboard.recentActivity')}>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t('dashboard.recentActivityPlaceholder')}
          </p>
        </Card>

        <Card title={t('dashboard.quickActions')}>
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
                {t('dashboard.newDeal')}
                <ArrowRight className="w-4 h-4 ml-auto opacity-50" />
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

