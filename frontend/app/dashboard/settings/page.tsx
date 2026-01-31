'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { useAuthStore } from '@/lib/stores/auth-store';
import { User, CreditCard, Key, Bell } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import { clsx } from 'clsx';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

const tabsConfig = [
  { id: 'profile' as const, i18nKey: 'profile', icon: User },
  { id: 'subscription' as const, i18nKey: 'subscription', icon: CreditCard },
  { id: 'security' as const, i18nKey: 'security', icon: Key },
  { id: 'notifications' as const, i18nKey: 'notifications', icon: Bell },
];

export default function SettingsPage() {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const [profile, setProfile] = useState<any>(null);
  const [subscription, setSubscription] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'profile' | 'subscription' | 'security' | 'notifications'>('profile');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [profileRes, subscriptionRes] = await Promise.all([
        axios.get(`${API_URL}/api/users/profile`).catch(() => ({ data: null })),
        axios.get(`${API_URL}/api/users/subscription`).catch(() => ({ data: null })),
      ]);

      setProfile(profileRes.data);
      setSubscription(subscriptionRes.data);
    } catch (error) {
      console.error('Error fetching settings:', error);
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight mb-1">
          {t('settings.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('settings.subtitle')}</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-6">
        <nav className="sm:w-56 flex-shrink-0 flex sm:flex-col gap-1 overflow-x-auto sm:overflow-visible pb-2 sm:pb-0">
          {tabsConfig.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={clsx(
                  'flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  activeTab === tab.id
                    ? 'bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <Icon className="w-5 h-5 shrink-0" />
                {t(`settings.${tab.i18nKey}`)}
              </button>
            );
          })}
        </nav>

        <div className="flex-1 min-w-0">
          <Card className="p-6">
            {activeTab === 'profile' && (
              <div className="space-y-6">
                <h2 className="font-heading text-lg font-semibold text-foreground tracking-tight">
                  {t('settings.profileTitle')}
                </h2>
                {profile ? (
                  <div className="space-y-4">
                    <Input
                      label={t('settings.firstName')}
                      type="text"
                      defaultValue={profile.first_name || ''}
                    />
                    <Input
                      label={t('settings.lastName')}
                      type="text"
                      defaultValue={profile.last_name || ''}
                    />
                    <Input
                      label={t('settings.email')}
                      type="email"
                      defaultValue={user?.email || ''}
                      disabled
                    />
                    <Button>{t('settings.saveChanges')}</Button>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">{t('settings.profileNotFound')}</p>
                )}
              </div>
            )}

            {activeTab === 'subscription' && (
              <div className="space-y-6">
                <h2 className="font-heading text-lg font-semibold text-foreground tracking-tight">
                  {t('settings.subscriptionTitle')}
                </h2>
                {subscription ? (
                  <div className="space-y-4">
                    <div className="p-4 rounded-xl bg-muted/50 border border-border">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium text-muted-foreground">{t('settings.currentPlan')}</span>
                        <span className="px-3 py-1 bg-primary/10 text-primary rounded-full text-sm font-medium capitalize">
                          {subscription.plan}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {t('settings.status')}: {subscription.status}
                      </p>
                    </div>
                    <Button>{t('settings.updateSubscription')}</Button>
                  </div>
                ) : (
                  <div>
                    <p className="text-muted-foreground text-sm mb-4">{t('settings.noSubscription')}</p>
                    <Button>{t('settings.choosePlan')}</Button>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'security' && (
              <div className="space-y-6">
                <h2 className="font-heading text-lg font-semibold text-foreground tracking-tight">
                  {t('settings.securityTitle')}
                </h2>
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-foreground mb-2">{t('settings.twoFactor')}</h3>
                    <p className="text-sm text-muted-foreground mb-3">{t('settings.twoFactorDesc')}</p>
                    <Button variant="outline">{t('settings.enable2fa')}</Button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'notifications' && (
              <div className="space-y-6">
                <h2 className="font-heading text-lg font-semibold text-foreground tracking-tight">
                  {t('settings.notificationsTitle')}
                </h2>
                <div className="space-y-4">
                  <div className="flex items-center justify-between py-3 border-b border-border">
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('settings.emailNotifications')}</p>
                      <p className="text-xs text-muted-foreground">{t('settings.emailNotificationsDesc')}</p>
                    </div>
                    <input type="checkbox" className="w-5 h-5 rounded border-border" defaultChecked />
                  </div>
                  <div className="flex items-center justify-between py-3 border-b border-border">
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('settings.pushNotifications')}</p>
                      <p className="text-xs text-muted-foreground">{t('settings.pushNotificationsDesc')}</p>
                    </div>
                    <input type="checkbox" className="w-5 h-5 rounded border-border" />
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
