'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/lib/api/client';
import { useAuthStore } from '@/lib/stores/auth-store';
import { canAccessWorkspaceSettings } from '@/lib/permissions';
import { User, CreditCard, Key, Bell, Building2, FileText } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import { clsx } from 'clsx';

type SettingsTab = 'profile' | 'workspace' | 'subscription' | 'security' | 'notifications' | 'audit';

const tabsConfig: { id: SettingsTab; i18nKey: string; icon: typeof User; ownerAdminOnly?: boolean }[] = [
  { id: 'profile', i18nKey: 'profile', icon: User },
  { id: 'workspace', i18nKey: 'workspace', icon: Building2 },
  { id: 'subscription', i18nKey: 'subscription', icon: CreditCard },
  { id: 'security', i18nKey: 'security', icon: Key },
  { id: 'notifications', i18nKey: 'notifications', icon: Bell },
  { id: 'audit', i18nKey: 'audit', icon: FileText, ownerAdminOnly: true },
];

export default function SettingsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user } = useAuthStore();
  const canEditWorkspace = canAccessWorkspaceSettings(user?.role);

  useEffect(() => {
    if (user != null && !canAccessWorkspaceSettings(user.role)) {
      router.replace('/dashboard');
    }
  }, [user, router]);
  const [profile, setProfile] = useState<any>(null);
  const [subscription, setSubscription] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');
  const [organization, setOrganization] = useState<{ id: string; name: string; slug: string } | null>(null);
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [workspaceForm, setWorkspaceForm] = useState({ name: '', slug: '' });
  const [orgMembers, setOrgMembers] = useState<{ user_id: string; email?: string }[]>([]);
  const [transferToUserId, setTransferToUserId] = useState('');
  const [transferring, setTransferring] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [auditLogs, setAuditLogs] = useState<{ id: string; user_id: string; action: string; resource_type: string | null; resource_id: string | null; old_value: unknown; new_value: unknown; ip: string | null; created_at: string }[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (activeTab === 'workspace' && !organization) {
      apiClient.get('/api/auth/organization').then((r) => {
        setOrganization(r.data);
        setWorkspaceForm({ name: r.data?.name ?? '', slug: r.data?.slug ?? '' });
      }).catch(() => setOrganization(null));
    }
  }, [activeTab, organization]);

  useEffect(() => {
    if (activeTab === 'workspace' && user?.role === 'owner') {
      apiClient.get('/api/team/members').then((r) => {
        const list = Array.isArray(r.data) ? r.data : [];
        const seen = new Set<string>();
        const members = list.filter((m: any) => {
          const id = m.user_id;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        }).map((m: any) => ({ user_id: m.user_id, email: m.email }));
        setOrgMembers(members);
      }).catch(() => setOrgMembers([]));
    }
  }, [activeTab, user?.role]);

  useEffect(() => {
    if (activeTab === 'audit' && canEditWorkspace) {
      setAuditLoading(true);
      apiClient.get('/api/auth/audit-logs', { params: { limit: 100 } }).then((r) => {
        setAuditLogs(Array.isArray(r.data) ? r.data : []);
      }).catch(() => setAuditLogs([])).finally(() => setAuditLoading(false));
    }
  }, [activeTab, canEditWorkspace]);

  const fetchData = async () => {
    try {
      const [profileRes, subscriptionRes] = await Promise.all([
        apiClient.get('/api/users/profile').catch(() => ({ data: null })),
        apiClient.get('/api/users/subscription').catch(() => ({ data: null })),
      ]);

      setProfile(profileRes.data);
      setSubscription(subscriptionRes.data);
    } catch (error) {
      console.error('Error fetching settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveWorkspace = async () => {
    if (!workspaceForm.name.trim()) return;
    setWorkspaceSaving(true);
    setWorkspaceError('');
    try {
      const res = await apiClient.patch('/api/auth/organization', {
        name: workspaceForm.name.trim(),
        slug: workspaceForm.slug.trim() || undefined,
      });
      setOrganization(res.data);
      setWorkspaceForm({ name: res.data.name, slug: res.data.slug });
    } catch (e: any) {
      setWorkspaceError(e?.response?.data?.error || 'Failed to save');
    } finally {
      setWorkspaceSaving(false);
    }
  };

  const handleTransferOwnership = async () => {
    if (!transferToUserId || !window.confirm(t('settings.transferConfirm'))) return;
    setTransferring(true);
    try {
      await apiClient.post('/api/auth/organization/transfer-ownership', { newOwnerUserId: transferToUserId });
      setTransferToUserId('');
      setOrgMembers([]);
      alert(t('settings.transferSuccess'));
      window.location.reload();
    } catch (e: any) {
      alert(e?.response?.data?.error || t('settings.transferError'));
    } finally {
      setTransferring(false);
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
          {tabsConfig.filter((tab) => !tab.ownerAdminOnly || canEditWorkspace).map((tab) => {
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

            {activeTab === 'workspace' && (
              <div className="space-y-6">
                <h2 className="font-heading text-lg font-semibold text-foreground tracking-tight">
                  {t('settings.workspaceTitle')}
                </h2>
                {organization ? (
                  <div className="space-y-4">
                    {!canEditWorkspace && (
                      <p className="text-sm text-muted-foreground rounded-lg bg-muted/50 px-3 py-2">
                        {t('settings.workspaceOnlyOwnerAdmin')}
                      </p>
                    )}
                    {workspaceError && (
                      <p className="text-sm text-destructive rounded-lg bg-destructive/10 px-3 py-2">{workspaceError}</p>
                    )}
                    <Input
                      label={t('settings.workspaceName')}
                      type="text"
                      value={workspaceForm.name}
                      onChange={(e) => canEditWorkspace && setWorkspaceForm((f) => ({ ...f, name: e.target.value }))}
                      disabled={!canEditWorkspace}
                    />
                    <div>
                      <Input
                        label={t('settings.workspaceSlug')}
                        type="text"
                        value={workspaceForm.slug}
                        onChange={(e) => canEditWorkspace && setWorkspaceForm((f) => ({ ...f, slug: e.target.value }))}
                        placeholder="my-workspace"
                        disabled={!canEditWorkspace}
                      />
                      <p className="text-xs text-muted-foreground mt-1">{t('settings.workspaceSlugHint')}</p>
                    </div>
                    {canEditWorkspace && (
                      <Button onClick={handleSaveWorkspace} disabled={workspaceSaving}>
                        {workspaceSaving ? t('common.loading') : t('settings.saveChanges')}
                      </Button>
                    )}
                    {user?.role === 'owner' && orgMembers.length > 0 && (
                      <div className="pt-6 border-t border-border space-y-3">
                        <h3 className="text-sm font-medium text-foreground">{t('settings.transferOwnership')}</h3>
                        <p className="text-sm text-muted-foreground">{t('settings.transferOwnershipHint')}</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={transferToUserId}
                            onChange={(e) => setTransferToUserId(e.target.value)}
                            className="px-3 py-2 border border-input rounded-lg bg-background text-foreground text-sm min-w-[200px]"
                          >
                            <option value="">{t('settings.transferTo')}</option>
                            {orgMembers.filter((m) => m.user_id !== user?.id).map((m) => (
                              <option key={m.user_id} value={m.user_id}>
                                {m.email || m.user_id}
                              </option>
                            ))}
                          </select>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={handleTransferOwnership}
                            disabled={!transferToUserId || transferring}
                          >
                            {transferring ? t('common.loading') : t('settings.transferOwnership')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">…</p>
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

            {activeTab === 'audit' && (
              <div className="space-y-6">
                <h2 className="font-heading text-lg font-semibold text-foreground tracking-tight">
                  {t('settings.auditTitle')}
                </h2>
                <p className="text-sm text-muted-foreground">{t('settings.auditDesc')}</p>
                {auditLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" aria-hidden />
                  </div>
                ) : auditLogs.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">{t('settings.auditEmpty')}</p>
                ) : (
                  <div className="overflow-x-auto -mx-6 px-6">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th className="py-2 pr-4 font-medium">{t('settings.auditDate')}</th>
                          <th className="py-2 pr-4 font-medium">{t('settings.auditAction')}</th>
                          <th className="py-2 pr-4 font-medium">{t('settings.auditUser')}</th>
                          <th className="py-2 pr-4 font-medium">{t('settings.auditDetails')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditLogs.map((log) => (
                          <tr key={log.id} className="border-b border-border/70">
                            <td className="py-2.5 pr-4 text-muted-foreground whitespace-nowrap">
                              {new Date(log.created_at).toLocaleString()}
                            </td>
                            <td className="py-2.5 pr-4 font-medium">{log.action}</td>
                            <td className="py-2.5 pr-4 font-mono text-xs">{log.user_id.slice(0, 8)}…</td>
                            <td className="py-2.5">
                              {(log.old_value || log.new_value) ? (
                                <span className="text-muted-foreground">
                                  {log.old_value && typeof log.old_value === 'object' ? JSON.stringify(log.old_value) : null}
                                  {log.old_value && log.new_value ? ' → ' : ''}
                                  {log.new_value && typeof log.new_value === 'object' ? JSON.stringify(log.new_value) : null}
                                </span>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
