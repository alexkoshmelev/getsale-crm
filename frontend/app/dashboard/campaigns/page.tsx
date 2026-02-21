'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { Send, Plus, MoreVertical, Play, PauseCircle, Pencil, Trash2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  fetchCampaigns,
  createCampaign,
  deleteCampaign,
  type Campaign,
  type CampaignStatus,
} from '@/lib/api/campaigns';
import { clsx } from 'clsx';

const statusLabels: Record<CampaignStatus, string> = {
  draft: 'campaigns.statusDraft',
  active: 'campaigns.statusActive',
  paused: 'campaigns.statusPaused',
  completed: 'campaigns.statusCompleted',
};

export default function CampaignsPage() {
  const { t } = useTranslation();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const list = await fetchCampaigns();
      setCampaigns(list);
    } catch (e) {
      console.error('Failed to load campaigns', e);
      setCampaigns([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await createCampaign({ name });
      setCreateModalOpen(false);
      setNewName('');
      window.location.href = `/dashboard/campaigns/${created.id}?tab=sequence`;
    } catch (e) {
      console.error('Failed to create campaign', e);
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
    } catch (e) {
      console.error('Failed to delete campaign', e);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[320px]">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" aria-hidden />
      </div>
    );
  }

  if (campaigns.length === 0 && !createModalOpen) {
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

      <div className="rounded-xl border border-border bg-card">
        <ul className="divide-y divide-border">
          {campaigns.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-4 px-4 py-4 hover:bg-muted/30 relative">
              <Link href={`/dashboard/campaigns/${c.id}`} className="flex-1 min-w-0 flex items-center gap-4">
                <div className="rounded-lg bg-primary/10 p-2">
                  <Send className="w-5 h-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-foreground truncate">{c.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {t(statusLabels[c.status] || c.status)}
                  </p>
                </div>
              </Link>
              <div className="flex items-center gap-2 relative">
                {(c.status === 'draft' || c.status === 'paused') && (
                  <Link href={`/dashboard/campaigns/${c.id}?tab=sequence`}>
                    <Button variant="ghost" size="sm">
                      <Pencil className="w-4 h-4" />
                    </Button>
                  </Link>
                )}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMenuId(menuId === c.id ? null : c.id)}
                    className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground"
                    aria-label={t('common.edit')}
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                  {menuId === c.id && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setMenuId(null)}
                        aria-hidden
                      />
                      <div className="absolute right-0 top-full mt-1 py-1 min-w-[140px] bg-popover border border-border rounded-lg shadow-lg z-50">
                        <Link href={`/dashboard/campaigns/${c.id}`}>
                          <span className="block px-3 py-2 text-sm hover:bg-muted cursor-pointer">
                            {t('campaigns.overview')}
                          </span>
                        </Link>
                        <Link href={`/dashboard/campaigns/${c.id}?tab=sequence`}>
                          <span className="block px-3 py-2 text-sm hover:bg-muted cursor-pointer">
                            {t('campaigns.sequence')}
                          </span>
                        </Link>
                        {(c.status === 'draft' || c.status === 'paused') && (
                          <button
                            type="button"
                            onClick={() => handleDelete(c)}
                            className="w-full text-left px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
                          >
                            {t('campaigns.deleteCampaign')}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

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
          className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
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
