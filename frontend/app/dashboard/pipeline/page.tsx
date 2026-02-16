'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { Plus, Circle, LayoutGrid, List, GripVertical, MoreVertical, Settings, Pencil, Trash2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pagination } from '@/components/ui/Pagination';
import { fetchPipelines, fetchStages, type Pipeline, type Stage } from '@/lib/api/pipeline';
import { fetchDeals, updateDealStage, deleteDeal, type Deal } from '@/lib/api/crm';
import { PipelineManageModal } from '@/components/pipeline/PipelineManageModal';
import { DealFormModal } from '@/components/crm/DealFormModal';
import { DealChatAvatar } from '@/components/crm/DealChatAvatar';

function dealCardTitle(deal: Deal): string {
  return (deal.title ?? '').trim() || (deal.companyName ?? deal.company_name ?? '').trim() || '—';
}

export default function PipelinePage() {
  const { t } = useTranslation();
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban');
  const [listPage, setListPage] = useState(1);
  const [listTotal, setListTotal] = useState(0);
  const [listLimit] = useState(10);
  const [loading, setLoading] = useState(true);
  const [draggingDealId, setDraggingDealId] = useState<string | null>(null);
  const [movingDealId, setMovingDealId] = useState<string | null>(null);
  const [dealMenuId, setDealMenuId] = useState<string | null>(null);
  const [manageModalOpen, setManageModalOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);

  const loadPipelines = useCallback(async () => {
    try {
      const list = await fetchPipelines();
      setPipelines(list);
      if (list.length > 0 && !selectedPipelineId) {
        const defaultPipe = list.find((p) => p.is_default) || list[0];
        setSelectedPipelineId(defaultPipe.id);
      }
    } catch (e) {
      console.error('Failed to load pipelines', e);
      setPipelines([]);
    }
  }, [selectedPipelineId]);

  const loadStagesAndDeals = useCallback(async () => {
    if (!selectedPipelineId) {
      setStages([]);
      setDeals([]);
      return;
    }
    setLoading(true);
    try {
      const [stagesList, dealsRes] = await Promise.all([
        fetchStages(selectedPipelineId),
        fetchDeals({ pipelineId: selectedPipelineId, limit: 500 }),
      ]);
      setStages(stagesList.sort((a, b) => a.order_index - b.order_index));
      setDeals(dealsRes.items);
    } catch (e) {
      console.error('Failed to load stages/deals', e);
      setStages([]);
      setDeals([]);
    } finally {
      setLoading(false);
    }
  }, [selectedPipelineId]);

  useEffect(() => {
    loadPipelines();
  }, []);

  useEffect(() => {
    loadStagesAndDeals();
  }, [loadStagesAndDeals]);

  const loadListPage = useCallback(async () => {
    if (!selectedPipelineId) return;
    setLoading(true);
    try {
      const res = await fetchDeals({
        pipelineId: selectedPipelineId,
        page: listPage,
        limit: listLimit,
      });
      setDeals(res.items);
      setListTotal(res.pagination.total);
    } catch (e) {
      console.error('Failed to load deals list', e);
    } finally {
      setLoading(false);
    }
  }, [selectedPipelineId, listPage, listLimit]);

  useEffect(() => {
    if (viewMode === 'list' && selectedPipelineId) loadListPage();
  }, [viewMode, selectedPipelineId, listPage, loadListPage]);

  const handleDrop = useCallback(
    async (dealId: string, toStageId: string) => {
      setDraggingDealId(null);
      const deal = deals.find((d) => d.id === dealId);
      if (!deal || deal.stage_id === toStageId) return;
      setMovingDealId(dealId);
      try {
        await updateDealStage(dealId, { stageId: toStageId });
        setDeals((prev) =>
          prev.map((d) => (d.id === dealId ? { ...d, stage_id: toStageId } : d))
        );
      } catch (e) {
        console.error('Failed to move deal', e);
      } finally {
        setMovingDealId(null);
      }
    },
    [deals]
  );

  const handleRemoveDeal = useCallback(
    async (dealId: string) => {
      setDealMenuId(null);
      try {
        await deleteDeal(dealId);
        setDeals((prev) => prev.filter((d) => d.id !== dealId));
      } catch (e) {
        console.error('Failed to remove deal', e);
      }
    },
    []
  );

  const dealsByStage = (stageId: string) => deals.filter((d) => d.stage_id === stageId);

  if (pipelines.length === 0 && !loading) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <div className="mb-4">
          <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight">{t('pipeline.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('pipeline.subtitle')}</p>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={LayoutGrid}
            title={t('pipeline.noPipelines')}
            description={t('pipeline.noPipelinesDesc')}
            action={
              <div className="flex flex-wrap gap-2 justify-center">
                <Button onClick={() => setManageModalOpen(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  {t('pipeline.addPipeline')}
                </Button>
                <Link href="/dashboard/crm">
                  <Button variant="outline">{t('pipeline.noStagesCta')}</Button>
                </Link>
              </div>
            }
          />
        </div>
        <PipelineManageModal
          open={manageModalOpen}
          onClose={() => setManageModalOpen(false)}
          selectedPipelineId={null}
          onPipelinesChange={loadPipelines}
          onStagesChange={loadStagesAndDeals}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 shrink-0">
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight">{t('pipeline.title')}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t('pipeline.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedPipelineId ?? ''}
            onChange={(e) => setSelectedPipelineId(e.target.value || null)}
            className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground min-w-[180px]"
            aria-label={t('pipeline.selectPipeline')}
          >
            <option value="">{t('pipeline.selectPipeline')}</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setManageModalOpen(true)}
            className="p-2 rounded-lg border border-border bg-muted/30 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t('pipeline.managePipelines')}
          >
            <Settings className="w-4 h-4" />
          </button>
          <div className="flex rounded-lg border border-border bg-muted/30 p-0.5">
            <button
              type="button"
              onClick={() => {
                setViewMode('kanban');
                loadStagesAndDeals();
              }}
              className={`px-3 py-1.5 text-sm rounded-md flex items-center gap-1.5 ${viewMode === 'kanban' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <LayoutGrid className="w-4 h-4" />
              {t('pipeline.viewKanban')}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 text-sm rounded-md flex items-center gap-1.5 ${viewMode === 'list' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <List className="w-4 h-4" />
              {t('pipeline.viewList')}
            </button>
          </div>
          <Link href="/dashboard/crm">
            <Button variant="outline" className="gap-2">
              <Plus className="w-4 h-4" />
              {t('pipeline.noDealsEmptyCta')}
            </Button>
          </Link>
        </div>
      </div>

      {!selectedPipelineId ? (
        <div className="flex-1 flex items-center justify-center py-12 text-muted-foreground text-sm">
          {t('pipeline.selectPipeline')}
        </div>
      ) : loading && stages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" aria-hidden />
        </div>
      ) : stages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center py-12">
          <EmptyState
            icon={LayoutGrid}
            title={t('pipeline.noStages')}
            description={t('pipeline.noStagesDesc')}
            action={
              <Link href="/dashboard/crm">
                <Button>{t('pipeline.noStagesCta')}</Button>
              </Link>
            }
          />
        </div>
      ) : viewMode === 'list' ? (
        <div className="flex-1 min-h-0 flex flex-col mt-4">
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" aria-hidden />
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-border bg-card shadow-soft overflow-hidden flex-1 min-h-0 flex flex-col">
                <table className="w-full">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {t('pipeline.dealCard', 'Сделка')}
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Stage
                      </th>
                      <th className="px-6 py-3 w-20" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {deals.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="px-6 py-12 text-center">
                          <p className="text-muted-foreground text-sm mb-3">{t('pipeline.noDealsEmptyTitle')}</p>
                          <Link href="/dashboard/crm" className="text-sm font-medium text-primary hover:underline">
                            {t('pipeline.noLeadsCta')} →
                          </Link>
                        </td>
                      </tr>
                    ) : (
                      deals.map((deal) => (
                        <tr key={deal.id} className="hover:bg-muted/30">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              {deal.bd_account_id && deal.channel_id ? (
                                <DealChatAvatar
                                  bdAccountId={deal.bd_account_id}
                                  channelId={deal.channel_id}
                                  title={dealCardTitle(deal)}
                                  className="w-8 h-8 shrink-0"
                                />
                              ) : null}
                              <button
                                type="button"
                                onClick={() => setEditingDeal(deal)}
                                className="font-medium text-foreground hover:underline text-left"
                              >
                                {dealCardTitle(deal)}
                              </button>
                            </div>
                            {(deal.value != null || deal.companyName || deal.company_name || deal.contactName || deal.ownerEmail) && (
                              <div className="text-xs text-muted-foreground mt-0.5 space-x-1.5">
                                {deal.value != null && <span>{`${deal.value} ${(deal.currency ?? '').trim()}`.trim()}</span>}
                                {(deal.companyName ?? deal.company_name) && <span>· {deal.companyName ?? deal.company_name}</span>}
                                {deal.contactName && <span>· {deal.contactName}</span>}
                                {deal.ownerEmail && <span>· {deal.ownerEmail}</span>}
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-4 text-sm text-muted-foreground">
                            {stages.find((s) => s.id === deal.stage_id)?.name ?? '—'}
                          </td>
                          <td className="px-6 py-4">
                            <div className="relative">
                              <button
                                type="button"
                                onClick={() => setDealMenuId(dealMenuId === deal.id ? null : deal.id)}
                                className="p-1.5 rounded text-muted-foreground hover:bg-accent"
                              >
                                <MoreVertical className="w-4 h-4" />
                              </button>
                              {dealMenuId === deal.id && (
                                <>
                                  <div
                                    className="fixed inset-0 z-10"
                                    aria-hidden
                                    onClick={() => setDealMenuId(null)}
                                  />
                                  <div className="absolute right-0 top-full mt-1 py-1 rounded-lg border border-border bg-card shadow-lg z-20 min-w-[160px]">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingDeal(deal);
                                        setDealMenuId(null);
                                      }}
                                      className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-accent flex items-center gap-2"
                                    >
                                      <Pencil className="w-3.5 h-3.5" />
                                      {t('pipeline.editDeal', 'Редактировать')}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleRemoveDeal(deal.id)}
                                      className="w-full text-left px-3 py-2 text-sm text-destructive hover:bg-destructive/10 flex items-center gap-2"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                      {t('pipeline.removeFromFunnel')}
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {listTotal > listLimit && (
                <div className="mt-4 flex justify-center">
                  <Pagination
                    page={listPage}
                    totalPages={Math.ceil(listTotal / listLimit)}
                    onPageChange={setListPage}
                  />
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex gap-4 overflow-x-auto overflow-y-hidden pb-4 mt-4 -mx-1 items-stretch">
          {stages.map((stage) => {
            const stageDeals = dealsByStage(stage.id);
            const stageColor = stage.color || undefined;
            return (
              <div
                key={stage.id}
                className="flex-shrink-0 w-80 rounded-xl border border-border bg-muted/30 flex flex-col overflow-hidden min-h-0"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.add('ring-2', 'ring-primary/30');
                }}
                onDragLeave={(e) => {
                  e.currentTarget.classList.remove('ring-2', 'ring-primary/30');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('ring-2', 'ring-primary/30');
                  const dealId = e.dataTransfer.getData('application/x-deal-id');
                  if (dealId) handleDrop(dealId, stage.id);
                }}
              >
                <div className="p-4 border-b border-border flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-2">
                    <Circle
                      className="w-3 h-3 shrink-0 text-muted-foreground"
                      style={stageColor ? { color: stageColor, fill: stageColor } : undefined}
                      fill={stageColor ?? 'currentColor'}
                    />
                    <h3 className="font-heading font-semibold text-foreground tracking-tight">{stage.name}</h3>
                  </div>
                  <span className="text-xs font-medium text-muted-foreground bg-card border border-border px-2 py-1 rounded-lg">
                    {t('pipeline.dealsCount', { count: stageDeals.length })}
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[120px]">
                  {stageDeals.map((deal) => {
                    const stageName = stages.find((s) => s.id === deal.stage_id)?.name ?? '—';
                    const stageColor = stages.find((s) => s.id === deal.stage_id)?.color;
                    const companyName = deal.companyName ?? deal.company_name ?? '';
                    const amountStr = deal.value != null ? `${deal.value} ${(deal.currency ?? '').trim()}`.trim() : '';
                    return (
                    <div
                      key={deal.id}
                      draggable
                      onDragStart={(e) => {
                        setDraggingDealId(deal.id);
                        e.dataTransfer.setData('application/x-deal-id', deal.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => setDraggingDealId(null)}
                      className={`bg-card rounded-lg p-3 border border-border shadow-soft cursor-grab active:cursor-grabbing flex flex-col gap-2 ${
                        draggingDealId === deal.id ? 'opacity-50' : 'hover:shadow-soft-md hover:border-primary/30'
                      } ${movingDealId === deal.id ? 'animate-pulse' : ''}`}
                    >
                      <div className="flex items-start gap-2 min-w-0">
                        <GripVertical className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                        {deal.bd_account_id && deal.channel_id ? (
                          <DealChatAvatar
                            bdAccountId={deal.bd_account_id}
                            channelId={deal.channel_id}
                            title={dealCardTitle(deal)}
                            className="w-9 h-9 shrink-0 mt-0.5"
                          />
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setEditingDeal(deal); }}
                            className="font-semibold text-foreground hover:underline block truncate text-sm text-left w-full"
                          >
                            {dealCardTitle(deal)}
                          </button>
                          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                            <span
                              className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-muted/80 text-foreground border border-border"
                              style={stageColor ? { borderColor: stageColor, color: stageColor } : undefined}
                            >
                              {stageName}
                            </span>
                            {amountStr && (
                              <span className="text-xs text-muted-foreground">{amountStr}</span>
                            )}
                            {deal.probability != null && (
                              <span className="text-xs text-muted-foreground">{deal.probability}%</span>
                            )}
                            {companyName && (
                              <span className="text-xs text-muted-foreground truncate max-w-[100px]" title={companyName}>
                                {companyName}
                              </span>
                            )}
                            {(deal.contactName ?? deal.ownerEmail) && (
                              <span className="text-xs text-muted-foreground truncate max-w-[100px]" title={[deal.contactName, deal.ownerEmail].filter(Boolean).join(' · ') || undefined}>
                                {deal.contactName ?? deal.ownerEmail}
                              </span>
                            )}
                          </div>
                          {deal.comments && (
                            <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]" title={deal.comments}>
                              {deal.comments}
                            </div>
                          )}
                        </div>
                        <div className="relative shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDealMenuId(dealMenuId === deal.id ? null : deal.id);
                          }}
                          className="p-1 rounded text-muted-foreground hover:bg-accent"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>
                        {dealMenuId === deal.id && (
                          <>
                            <div
                              className="fixed inset-0 z-10"
                              aria-hidden
                              onClick={() => setDealMenuId(null)}
                            />
                            <div className="absolute right-0 top-full mt-1 py-1 rounded-lg border border-border bg-card shadow-lg z-20 min-w-[160px]">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingDeal(deal);
                                  setDealMenuId(null);
                                }}
                                className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-accent flex items-center gap-2"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                                {t('pipeline.editDeal', 'Редактировать')}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRemoveDeal(deal.id)}
                                className="w-full text-left px-3 py-2 text-sm text-destructive hover:bg-destructive/10 flex items-center gap-2"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                {t('pipeline.removeFromFunnel')}
                              </button>
                            </div>
                          </>
                        )}
                        </div>
                      </div>
                    </div>
                    );
                  })}
                  {stageDeals.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground text-sm rounded-lg border border-dashed border-border">
                      {t('pipeline.noDealsInStage', 'Нет сделок')}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {stages.length > 0 && deals.length === 0 && viewMode === 'kanban' && (
        <div className="mt-4 p-4 rounded-xl border border-dashed border-border bg-muted/20 text-center">
          <p className="text-sm text-muted-foreground mb-2">{t('pipeline.noDealsEmptyDesc')}</p>
          <Link href="/dashboard/crm">
            <Button variant="outline" size="sm">{t('pipeline.noDealsEmptyCta')}</Button>
          </Link>
        </div>
      )}

      <PipelineManageModal
        open={manageModalOpen}
        onClose={() => setManageModalOpen(false)}
        selectedPipelineId={selectedPipelineId}
        onPipelinesChange={loadPipelines}
        onStagesChange={loadStagesAndDeals}
      />
      <DealFormModal
        isOpen={!!editingDeal}
        onClose={() => setEditingDeal(null)}
        onSuccess={() => {
          loadStagesAndDeals();
          setEditingDeal(null);
        }}
        edit={editingDeal ?? undefined}
      />
    </div>
  );
}
