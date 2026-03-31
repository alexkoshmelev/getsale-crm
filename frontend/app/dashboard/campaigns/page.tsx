'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { Send, Plus, MoreVertical, Pencil, ChevronLeft, ChevronRight, Users, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  fetchCampaigns,
  createCampaign,
  deleteCampaign,
  type Campaign,
  type CampaignStatus,
  type CampaignListResponse,
} from '@/lib/api/campaigns';
import { clsx } from 'clsx';
import { AccountStatusAvatar } from '@/components/bd-accounts/AccountStatusAvatar';

const statusLabels: Record<CampaignStatus, string> = {
  draft: 'campaigns.statusDraft',
  active: 'campaigns.statusActive',
  paused: 'campaigns.statusPaused',
  completed: 'campaigns.statusCompleted',
};

const statusColors: Record<CampaignStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
  paused: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  completed: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
};

const PAGE_SIZE = 20;

export default function CampaignsPage() {
  const { t } = useTranslation();
  const [response, setResponse] = useState<CampaignListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [filterStatus, setFilterStatus] = useState<CampaignStatus | ''>('');

  const load = useCallback(async (p: number = page, status?: CampaignStatus | '') => {
    setLoading(true);
    try {
      const params: { page: number; limit: number; status?: CampaignStatus } = { page: p, limit: PAGE_SIZE };
      const s = status !== undefined ? status : filterStatus;
      if (s) params.status = s;
      const res = await fetchCampaigns(params);
      setResponse(res);
    } catch {
      setResponse(null);
    } finally {
      setLoading(false);
    }
  }, [page, filterStatus]);

  useEffect(() => {
    load(page, filterStatus);
  }, [page, filterStatus]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await createCampaign({ name });
      setCreateModalOpen(false);
      setNewName('');
      window.location.href = `/dashboard/campaigns/${created.id}?tab=audience`;
    } catch {
      // handled by toast in apiClient
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (c: Campaign) => {
    if (!confirm(t('campaigns.deleteCampaignConfirm', { name: c.name }))) return;
    try {
      await deleteCampaign(c.id);
      setMenuId(null);
      load();
    } catch {
      // handled
    }
  };

  const campaigns = response?.data ?? [];
  const totalCount = response?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const summary = response?.summary;

  const isEmpty = !loading && campaigns.length === 0 && !filterStatus;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight mb-1">
            {t('campaigns.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('campaigns.subtitle')}</p>
        </div>
        <Button onClick={() => setCreateModalOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          {t('campaigns.newCampaign')}
        </Button>
      </div>

      {isEmpty ? (
        <div className="flex-1 flex items-center justify-center py-16">
          <EmptyState
            icon={Send}
            title={t('campaigns.noCampaigns')}
            description={t('campaigns.noCampaignsDesc')}
            action={
              <Button onClick={() => setCreateModalOpen(true)}>{t('campaigns.createFirst')}</Button>
            }
          />
        </div>
      ) : (
        <>
          {summary && (
            <div className="grid grid-cols-3 gap-4">
              <SummaryCard icon={Send} label={t('campaigns.totalSent')} value={summary.total_sent} />
              <SummaryCard icon={BarChart3} label={t('campaigns.totalReplied')} value={summary.total_replied} accent />
              <SummaryCard icon={Users} label={t('campaigns.totalWon')} value={summary.total_won} emerald />
            </div>
          )}

          <div className="flex items-center gap-2">
            {(['', 'draft', 'active', 'paused', 'completed'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => { setFilterStatus(s as CampaignStatus | ''); setPage(1); }}
                className={clsx(
                  'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
                  filterStatus === s
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                )}
              >
                {s ? t(statusLabels[s]) : t('common.all')}
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-border bg-card overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('campaigns.campaignName')}</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('campaigns.statusLabel')}</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">{t('campaigns.owner')}</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell">{t('campaigns.bdAccount')}</th>
                      <th className="text-right px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">{t('campaigns.participants')}</th>
                      <th className="text-right px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">{t('campaigns.sent')}</th>
                      <th className="text-right px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">{t('campaigns.replied')}</th>
                      <th className="text-right px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell">{t('campaigns.won')}</th>
                      <th className="w-12 px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {campaigns.map((c) => (
                      <tr key={c.id} className="hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <Link href={`/dashboard/campaigns/${c.id}`} className="font-medium text-foreground hover:text-primary truncate block max-w-[240px]">
                            {c.name}
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <span className={clsx('inline-flex px-2 py-0.5 rounded-md text-xs font-medium', statusColors[c.status])}>
                            {t(statusLabels[c.status] || c.status)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground hidden md:table-cell truncate max-w-[150px]">
                          {c.owner_name || '—'}
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell">
                          <div className="flex -space-x-1 items-center min-h-[28px]">
                            {(c.bd_accounts ?? []).map((acc) => (
                              <AccountStatusAvatar key={acc.id} accountId={acc.id} account={acc} size="sm" showTooltip />
                            ))}
                            {!(c.bd_accounts?.length) && <span className="text-muted-foreground">—</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground hidden sm:table-cell">
                          {c.total_participants ?? 0}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums hidden sm:table-cell">
                          {c.total_sent ?? 0}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums hidden sm:table-cell">
                          <span className={clsx((c.total_replied ?? 0) > 0 && 'text-primary font-medium')}>
                            {c.total_replied ?? 0}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums hidden lg:table-cell">
                          <span className={clsx((c.total_won ?? 0) > 0 && 'text-emerald-600 dark:text-emerald-400 font-medium')}>
                            {c.total_won ?? 0}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() => setMenuId(menuId === c.id ? null : c.id)}
                              className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground"
                            >
                              <MoreVertical className="w-4 h-4" />
                            </button>
                            {menuId === c.id && (
                              <>
                                <div className="fixed inset-0 z-40" onClick={() => setMenuId(null)} aria-hidden />
                                <div className="absolute right-0 top-full mt-1 py-1 min-w-[140px] bg-popover border border-border rounded-lg shadow-lg z-50">
                                  <Link href={`/dashboard/campaigns/${c.id}`}>
                                    <span className="block px-3 py-2 text-sm hover:bg-muted cursor-pointer">{t('campaigns.overview')}</span>
                                  </Link>
                                  <Link href={`/dashboard/campaigns/${c.id}?tab=sequence`}>
                                    <span className="block px-3 py-2 text-sm hover:bg-muted cursor-pointer">{t('campaigns.sequence')}</span>
                                  </Link>
                                  {(c.status === 'draft' || c.status === 'paused') && (
                                    <>
                                      <Link href={`/dashboard/campaigns/${c.id}?tab=sequence`}>
                                        <span className="block px-3 py-2 text-sm hover:bg-muted cursor-pointer">
                                          <Pencil className="w-3.5 h-3.5 inline mr-1.5" />{t('common.edit')}
                                        </span>
                                      </Link>
                                      <button
                                        type="button"
                                        onClick={() => handleDelete(c)}
                                        className="w-full text-left px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
                                      >
                                        {t('campaigns.deleteCampaign')}
                                      </button>
                                    </>
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-1">
              <p className="text-sm text-muted-foreground">
                {t('common.showingOf', { from: (page - 1) * PAGE_SIZE + 1, to: Math.min(page * PAGE_SIZE, totalCount), total: totalCount })}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  const startPage = Math.max(1, Math.min(page - 2, totalPages - 4));
                  const p = startPage + i;
                  if (p > totalPages) return null;
                  return (
                    <Button
                      key={p}
                      variant={p === page ? 'primary' : 'outline'}
                      size="sm"
                      onClick={() => setPage(p)}
                      className="min-w-[36px]"
                    >
                      {p}
                    </Button>
                  );
                })}
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {createModalOpen && (
        <CreateCampaignModal
          name={newName}
          setName={setNewName}
          onSave={handleCreate}
          onClose={() => setCreateModalOpen(false)}
          saving={creating}
          t={t}
        />
      )}
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, accent, emerald }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  accent?: boolean;
  emerald?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
      <div className={clsx('rounded-lg p-2', emerald ? 'bg-emerald-100 dark:bg-emerald-900/30' : accent ? 'bg-primary/10' : 'bg-muted')}>
        <Icon className={clsx('w-5 h-5', emerald ? 'text-emerald-600 dark:text-emerald-400' : accent ? 'text-primary' : 'text-muted-foreground')} />
      </div>
      <div>
        <p className="text-2xl font-bold text-foreground tabular-nums">{value.toLocaleString()}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function CreateCampaignModal({
  name,
  setName,
  onSave,
  onClose,
  saving,
  t,
}: {
  name: string;
  setName: (v: string) => void;
  onSave: () => void;
  onClose: () => void;
  saving: boolean;
  t: (key: string) => string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card shadow-xl p-6">
        <h3 className="font-heading text-lg font-semibold text-foreground mb-4">
          {t('campaigns.newCampaign')}
        </h3>
        <label className="block text-sm font-medium text-foreground mb-2">
          {t('campaigns.campaignName')}
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('campaigns.campaignNamePlaceholder')}
          className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
          autoFocus
        />
        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onSave} disabled={!name.trim() || saving}>
            {saving ? t('campaigns.saving') : t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
