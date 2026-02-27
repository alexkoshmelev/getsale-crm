'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { Plus, Circle, LayoutGrid, List, CalendarClock, GripVertical, MoreVertical, Settings, Pencil, Trash2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pagination } from '@/components/ui/Pagination';
import { fetchPipelines, fetchStages, fetchLeads, updateLead, removeLead, type Pipeline, type Stage, type Lead } from '@/lib/api/pipeline';
import { PipelineManageModal } from '@/components/pipeline/PipelineManageModal';

function leadContactName(lead: Lead): string {
  const parts = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
  return parts || (lead.display_name ?? '').trim() || (lead.email ?? '').trim() || (lead.telegram_id ?? '').trim() || '—';
}

function toLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getLaneInitials(laneLabel: string, laneKey: string, noCreatorKey: string): string {
  if (laneKey === '__none__' || laneLabel === noCreatorKey) return '—';
  if (laneLabel.includes('@')) {
    const [local, domain] = laneLabel.split('@');
    const a = (local ?? '')[0] ?? '';
    const b = (domain ?? '')[0] ?? '';
    return (a + b).toUpperCase() || '?';
  }
  const trimmed = laneLabel.trim();
  if (trimmed.length >= 2) return trimmed.slice(0, 2).toUpperCase();
  return (trimmed[0] ?? '?').toUpperCase();
}

export default function PipelinePage() {
  const { t, i18n } = useTranslation();
  const dragPreviewRef = useRef<HTMLDivElement>(null);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [viewMode, setViewMode] = useState<'kanban' | 'list' | 'timeline'>('kanban');
  const [listPage, setListPage] = useState(1);
  const [listLimit] = useState(20);
  const [loading, setLoading] = useState(true);
  const [draggingLeadId, setDraggingLeadId] = useState<string | null>(null);
  const [movingLeadId, setMovingLeadId] = useState<string | null>(null);
  const [leadMenuId, setLeadMenuId] = useState<string | null>(null);
  const [manageModalOpen, setManageModalOpen] = useState(false);
  const [filterStageId, setFilterStageId] = useState<string | null>(null);
  const [filterSearch, setFilterSearch] = useState('');
  const [filterSearchDebounced, setFilterSearchDebounced] = useState('');
  const [timelineLaneFilter, setTimelineLaneFilter] = useState<string[]>([]);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrolledToTodayRef = useRef(false);

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

  const loadStagesAndLeads = useCallback(async () => {
    if (!selectedPipelineId) {
      setStages([]);
      setLeads([]);
      return;
    }
    setLoading(true);
    try {
      const [stagesList, leadsRes] = await Promise.all([
        fetchStages(selectedPipelineId),
        fetchLeads({ pipelineId: selectedPipelineId, limit: 500, stageId: filterStageId ?? undefined }),
      ]);
      setStages(stagesList.sort((a, b) => a.order_index - b.order_index));
      setLeads(leadsRes.items);
    } catch (e) {
      console.error('Failed to load stages/leads', e);
      setStages([]);
      setLeads([]);
    } finally {
      setLoading(false);
    }
  }, [selectedPipelineId, filterStageId]);

  useEffect(() => {
    loadPipelines();
  }, []);

  useEffect(() => {
    if (selectedPipelineId && typeof window !== 'undefined') {
      window.localStorage.setItem('pipeline.selectedPipelineId', selectedPipelineId);
    }
  }, [selectedPipelineId]);

  useEffect(() => {
    const id = setTimeout(() => setFilterSearchDebounced(filterSearch), 300);
    return () => clearTimeout(id);
  }, [filterSearch]);

  useEffect(() => {
    setListPage(1);
  }, [filterSearchDebounced, filterStageId]);

  useEffect(() => {
    loadStagesAndLeads();
  }, [loadStagesAndLeads]);

  const searchLower = filterSearchDebounced.trim().toLowerCase();
  const filteredLeads = searchLower
    ? leads.filter((l) => leadContactName(l).toLowerCase().includes(searchLower))
    : leads;
  const listTotal = filteredLeads.length;
  const listSlice = filteredLeads.slice((listPage - 1) * listLimit, listPage * listLimit);

  const leadsByDate = (() => {
    const sorted = [...filteredLeads].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const groups: { dateKey: string; label: string; leads: Lead[] }[] = [];
    const seen = new Set<string>();
    for (const lead of sorted) {
      const d = new Date(lead.created_at);
      const dateKey = d.toISOString().slice(0, 10);
      if (!seen.has(dateKey)) {
        seen.add(dateKey);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const leadDay = new Date(d);
        leadDay.setHours(0, 0, 0, 0);
        let label = dateKey;
        if (leadDay.getTime() === today.getTime()) label = t('pipeline.timelineToday');
        else if (leadDay.getTime() === yesterday.getTime()) label = t('pipeline.timelineYesterday');
        else label = d.toLocaleDateString(i18n.language || 'ru', { day: 'numeric', month: 'short', year: 'numeric' });
        groups.push({ dateKey, label, leads: [] });
      }
      const g = groups.find((x) => x.dateKey === dateKey);
      if (g) g.leads.push(lead);
    }
    return groups;
  })();

  const timelineLanes = stages.map((stage) => ({
    laneKey: stage.id,
    laneLabel: stage.name,
    leads: filteredLeads.filter((l) => l.stage_id === stage.id),
  }));

  const filteredTimelineLanes = timelineLaneFilter.length === 0
    ? timelineLanes
    : timelineLanes.filter((l) => timelineLaneFilter.includes(l.laneKey));

  const DAYS_BACK = 21;
  const DAYS_FORWARD = 21;
  const timelineDateColumns = (() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cols: { dateKey: string; label: string }[] = [];
    for (let i = -DAYS_BACK; i <= DAYS_FORWARD; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const dateKey = toLocalDateKey(d);
      const dealDay = new Date(d);
      dealDay.setHours(0, 0, 0, 0);
      const isToday = dealDay.getTime() === today.getTime();
      const label = isToday ? t('pipeline.timelineToday') : d.toLocaleDateString(i18n.language || 'ru', { weekday: 'short', day: 'numeric', month: 'short' });
      cols.push({ dateKey, label });
    }
    return cols;
  })();

  useEffect(() => {
    if (viewMode !== 'timeline') {
      timelineScrolledToTodayRef.current = false;
      return;
    }
    if (loading || filteredTimelineLanes.length === 0) return;
    const el = timelineScrollRef.current;
    if (!el || timelineScrolledToTodayRef.current) return;
    const firstColWidth = 64;
    const dateColWidth = 180;
    const scrollToToday = () => {
      const todayOffset = firstColWidth + DAYS_BACK * dateColWidth;
      el.scrollLeft = todayOffset;
      timelineScrolledToTodayRef.current = true;
    };
    const id = setTimeout(scrollToToday, 0);
    return () => clearTimeout(id);
  }, [viewMode, loading, filteredTimelineLanes.length]);

  function getLeadsForLaneAndDate(laneKey: string, dateKey: string): Lead[] {
    const lane = filteredTimelineLanes.find((l) => l.laneKey === laneKey);
    if (!lane) return [];
    return lane.leads.filter((lead) => toLocalDateKey(new Date(lead.created_at)) === dateKey);
  }

  function daysInFunnel(createdAt: string): number {
    const created = new Date(createdAt);
    created.setHours(0, 0, 0, 0);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.floor((now.getTime() - created.getTime()) / (24 * 60 * 60 * 1000));
  }

  function formatInFunnel(createdAt: string): { text: string; isLong: boolean } {
    const created = new Date(createdAt).getTime();
    const now = Date.now();
    const ms = now - created;
    const hours = Math.floor(ms / (60 * 60 * 1000));
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    if (hours < 24) return { text: t('pipeline.timelineHoursInFunnel', { count: hours }), isLong: false };
    if (days < 7) return { text: t('pipeline.timelineDaysInFunnelShort', { count: days }), isLong: false };
    const weeks = Math.floor(days / 7);
    if (days < 28) return { text: t('pipeline.timelineWeeksInFunnel', { count: weeks }), isLong: true };
    const months = Math.floor(days / 28);
    return { text: t('pipeline.timelineMonthsInFunnel', { count: months }), isLong: true };
  }

  const handleDrop = useCallback(async (leadId: string, toStageId: string) => {
    setDraggingLeadId(null);
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.stage_id === toStageId) return;
    setMovingLeadId(leadId);
    try {
      await updateLead(leadId, { stageId: toStageId });
      setLeads((prev) =>
        prev.map((l) => (l.id === leadId ? { ...l, stage_id: toStageId } : l))
      );
    } catch (e) {
      console.error('Failed to move lead', e);
    } finally {
      setMovingLeadId(null);
    }
  }, [leads]);

  const handleRemoveLead = useCallback(async (leadId: string) => {
    setLeadMenuId(null);
    try {
      await removeLead(leadId);
      setLeads((prev) => prev.filter((l) => l.id !== leadId));
    } catch (e) {
      console.error('Failed to remove lead from pipeline', e);
    }
  }, []);

  const itemsByStage = (stageId: string): Lead[] =>
    filteredLeads.filter((l) => l.stage_id === stageId);

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
          onStagesChange={loadStagesAndLeads}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div ref={dragPreviewRef} className="fixed left-[-9999px] top-0 z-[9999] px-3 py-2 rounded-lg bg-card border border-border shadow-lg text-sm font-medium truncate max-w-[220px] pointer-events-none" aria-hidden />
      <div className="flex flex-col gap-4 shrink-0 mb-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight">{t('pipeline.title')}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{t('pipeline.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={selectedPipelineId ?? ''}
              onChange={(e) => setSelectedPipelineId(e.target.value || null)}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground min-w-[180px] shadow-sm"
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
              className="p-2 rounded-lg border border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground shadow-sm"
              title={t('pipeline.managePipelines')}
            >
              <Settings className="w-4 h-4" />
            </button>
            <Link href="/dashboard/crm">
              <Button variant="outline" className="gap-2 shadow-sm">
                <Plus className="w-4 h-4" />
                {t('pipeline.noLeadsCta', 'Контакты')}
              </Button>
            </Link>
          </div>
        </div>
        {selectedPipelineId && (
          <div className="flex flex-col gap-3">
            <nav className="flex items-center gap-1 border-b border-border" aria-label={t('pipeline.viewMode')}>
              <button
                type="button"
                onClick={() => { setViewMode('kanban'); loadStagesAndLeads(); }}
                className={`px-4 py-2.5 text-sm font-medium rounded-t-lg flex items-center gap-2 -mb-px transition-colors ${viewMode === 'kanban' ? 'text-primary border-b-2 border-primary bg-card' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <LayoutGrid className="w-4 h-4" />
                {t('pipeline.viewKanban')}
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`px-4 py-2.5 text-sm font-medium rounded-t-lg flex items-center gap-2 -mb-px transition-colors ${viewMode === 'list' ? 'text-primary border-b-2 border-primary bg-card' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <List className="w-4 h-4" />
                {t('pipeline.viewList')}
              </button>
              <button
                type="button"
                onClick={() => { setViewMode('timeline'); loadStagesAndLeads(); }}
                className={`px-4 py-2.5 text-sm font-medium rounded-t-lg flex items-center gap-2 -mb-px transition-colors ${viewMode === 'timeline' ? 'text-primary border-b-2 border-primary bg-card' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <CalendarClock className="w-4 h-4" />
                {t('pipeline.viewTimeline')}
              </button>
            </nav>
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-3 py-2">
              <input
                type="search"
                value={filterSearch}
                onChange={(e) => setFilterSearch(e.target.value)}
                placeholder={t('pipeline.filterSearch', 'Поиск по имени')}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground min-w-[140px] placeholder:text-muted-foreground"
                aria-label={t('pipeline.filterSearch')}
              />
              <select
                value={filterStageId ?? ''}
                onChange={(e) => setFilterStageId(e.target.value || null)}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground min-w-[120px]"
                aria-label={t('pipeline.filterStage')}
              >
                <option value="">{t('pipeline.filterAllStages')}</option>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 rounded-xl border border-border bg-card shadow-sm overflow-hidden flex flex-col">
      {!selectedPipelineId ? (
        <div className="flex-1 flex items-center justify-center py-16 text-muted-foreground text-sm">
          {t('pipeline.selectPipeline')}
        </div>
      ) : loading && stages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" aria-hidden />
        </div>
      ) : stages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center py-16">
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
        <div className="flex-1 min-h-0 flex flex-col p-4">
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" aria-hidden />
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-border bg-card shadow-soft overflow-hidden flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <table className="w-full">
                    <thead className="sticky top-0 z-10 bg-card border-b border-border">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {t('pipeline.leadCard', 'Лид')}
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                        {t('pipeline.listColStage', 'Стадия')}
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                        {t('pipeline.listColCreatedAt', 'Дата создания')}
                      </th>
                      <th className="px-6 py-3 w-20" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {listSlice.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-6 py-12 text-center">
                          <p className="text-muted-foreground text-sm mb-3">{t('pipeline.noLeadsEmptyTitle', 'Нет лидов в воронке')}</p>
                          <Link href="/dashboard/crm" className="text-sm font-medium text-primary hover:underline">
                            {t('pipeline.noLeadsCta')} →
                          </Link>
                        </td>
                      </tr>
                    ) : (
                      listSlice.map((lead) => {
                        const stageColor = stages.find((s) => s.id === lead.stage_id)?.color;
                        return (
                        <tr key={lead.id} className="hover:bg-muted/30 group" style={stageColor ? { borderLeft: `4px solid ${stageColor}` } : undefined}>
                          <td className="px-6 py-4">
                            <Link
                              href={`/dashboard/messaging?contactId=${lead.contact_id}`}
                              className="font-medium text-foreground hover:underline"
                            >
                              {leadContactName(lead)}
                            </Link>
                          </td>
                          <td className="px-6 py-4 text-sm text-muted-foreground">
                            {stages.find((s) => s.id === lead.stage_id)?.name ?? '—'}
                          </td>
                          <td className="px-6 py-4 text-sm text-muted-foreground whitespace-nowrap">
                            {new Date(lead.created_at).toLocaleDateString(i18n.language || 'ru', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td className="px-6 py-4">
                            <div className="relative">
                              <button
                                type="button"
                                onClick={() => setLeadMenuId(leadMenuId === lead.id ? null : lead.id)}
                                className="p-1.5 rounded text-muted-foreground hover:bg-accent"
                              >
                                <MoreVertical className="w-4 h-4" />
                              </button>
                              {leadMenuId === lead.id && (
                                <>
                                  <div
                                    className="fixed inset-0 z-10"
                                    aria-hidden
                                    onClick={() => setLeadMenuId(null)}
                                  />
                                  <div className="absolute right-0 top-full mt-1 py-1 rounded-lg border border-border bg-card shadow-lg z-20 min-w-[160px]">
                                    <button
                                      type="button"
                                      onClick={() => handleRemoveLead(lead.id)}
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
                        );
                      })
                    )}
                  </tbody>
                  </table>
                </div>
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
      ) : viewMode === 'timeline' ? (
        <div className="flex-1 min-h-0 flex flex-col p-4">
          <div className="shrink-0 mb-3">
            <p className="text-xs text-muted-foreground mb-3">{t('pipeline.timelineByCreated')}</p>
            {timelineLanes.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <span className="text-xs font-medium text-muted-foreground">{t('pipeline.timelineLanes')}:</span>
                <button
                  type="button"
                  onClick={() => setTimelineLaneFilter([])}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${timelineLaneFilter.length === 0 ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border text-muted-foreground hover:text-foreground hover:border-foreground/30'}`}
                >
                  {t('pipeline.timelineLanesAll')}
                </button>
                {timelineLanes.map(({ laneKey, laneLabel, leads: laneLeads }) => {
                  const selected = timelineLaneFilter.length === 0 || timelineLaneFilter.includes(laneKey);
                  const toggle = () => {
                    if (timelineLaneFilter.length === 0) {
                      setTimelineLaneFilter([laneKey]);
                    } else if (timelineLaneFilter.includes(laneKey)) {
                      const next = timelineLaneFilter.filter((k) => k !== laneKey);
                      setTimelineLaneFilter(next.length === 0 ? [] : next);
                    } else {
                      setTimelineLaneFilter([...timelineLaneFilter, laneKey]);
                    }
                  };
                  return (
                    <button
                      key={laneKey}
                      type="button"
                      onClick={toggle}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${selected ? 'bg-background border-border text-foreground' : 'border-border text-muted-foreground opacity-60 hover:opacity-100'}`}
                      title={`${laneLabel} (${laneLeads.length})`}
                    >
                      {laneLabel} ({laneLeads.length})
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" aria-hidden />
            </div>
          ) : filteredTimelineLanes.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground text-sm">
              <p className="mb-2">{timelineLaneFilter.length > 0 ? t('pipeline.timelineNoLanesSelected') : t('pipeline.noLeadsEmptyTitle', 'Нет лидов')}</p>
              {timelineLaneFilter.length > 0 ? (
                <button type="button" onClick={() => setTimelineLaneFilter([])} className="text-sm font-medium text-primary hover:underline">
                  {t('pipeline.timelineLanesAll')}
                </button>
              ) : (
                <Link href="/dashboard/crm" className="text-sm font-medium text-primary hover:underline">{t('pipeline.noLeadsCta')} →</Link>
              )}
            </div>
          ) : (
            <div ref={timelineScrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-auto">
              <div className="inline-flex min-w-max border border-border rounded-xl overflow-hidden bg-muted/20">
                <table className="border-collapse table-fixed" style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
                  <colgroup>
                    <col style={{ width: 64, minWidth: 64, maxWidth: 64 }} />
                    {timelineDateColumns.map(({ dateKey }) => (
                      <col key={dateKey} style={{ width: 180, minWidth: 180 }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ width: 64, minWidth: 64, maxWidth: 64 }} className="sticky left-0 z-20 bg-muted/80 backdrop-blur-sm border-b border-r border-border px-0 py-2 text-center shadow-[2px_0_6px_-1px_rgba(0,0,0,0.08)]" aria-label={t('pipeline.timelineLanes')} />
                      {timelineDateColumns.map(({ dateKey, label }) => {
                        const isToday = label === t('pipeline.timelineToday');
                        return (
                          <th key={dateKey} className="min-w-[180px] w-[180px] border-b border-border px-2 py-2 text-center text-xs font-semibold bg-muted/40">
                            <span className={isToday ? 'text-primary' : 'text-muted-foreground'}>{label}</span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTimelineLanes.map(({ laneKey, laneLabel, leads: laneLeads }) => {
                      const initials = getLaneInitials(laneLabel, laneKey, t('pipeline.timelineLaneNoCreator'));
                      return (
                      <tr key={laneKey} className="border-b border-border last:border-b-0 hover:bg-muted/20">
                        <td style={{ width: 64, minWidth: 64, maxWidth: 64 }} className="sticky left-0 z-20 bg-card border-r border-border px-0 py-2 align-top shadow-[2px_0_6px_-1px_rgba(0,0,0,0.08)]">
                          <div className="flex flex-col items-center gap-1 w-full overflow-hidden">
                            <div
                              className="w-10 h-10 rounded-full bg-primary/15 text-primary flex items-center justify-center text-sm font-semibold shrink-0 border border-border/50"
                              title={laneLabel + (laneLeads.length ? ` (${laneLeads.length})` : '')}
                            >
                              {initials}
                            </div>
                            <span className="text-[10px] text-muted-foreground tabular-nums">{laneLeads.length}</span>
                          </div>
                        </td>
                        {timelineDateColumns.map(({ dateKey }) => {
                          const dayLeads = getLeadsForLaneAndDate(laneKey, dateKey);
                          return (
                            <td key={dateKey} className="min-w-[180px] w-[180px] align-top p-2 bg-card/50">
                              <ul className="space-y-2">
                                {dayLeads.map((lead) => {
                                  const stageColor = stages.find((s) => s.id === lead.stage_id)?.color;
                                  const createdDate = new Date(lead.created_at);
                                  const inFunnel = formatInFunnel(lead.created_at);
                                  return (
                                    <li key={lead.id}>
                                      <Link
                                        href={`/dashboard/messaging?contactId=${lead.contact_id}`}
                                        className="block bg-card rounded-lg p-2.5 border border-border border-l-4 shadow-sm hover:shadow-md hover:border-primary/30 transition-shadow"
                                        style={stageColor ? { borderLeftColor: stageColor } : undefined}
                                      >
                                        <p className="font-medium text-foreground text-sm truncate">{leadContactName(lead)}</p>
                                        <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground mt-1">
                                          <span title={createdDate.toLocaleString(i18n.language || 'ru')}>
                                            {createdDate.toLocaleDateString(i18n.language || 'ru', { day: 'numeric', month: 'short', year: 'numeric' })} {createdDate.toLocaleTimeString(i18n.language || 'ru', { hour: '2-digit', minute: '2-digit' })}
                                          </span>
                                          <span className={inFunnel.isLong ? 'text-amber-600 dark:text-amber-400 font-medium' : undefined} title={t('pipeline.timelineDaysInFunnelHint')}>
                                            {inFunnel.text}
                                          </span>
                                        </div>
                                      </Link>
                                    </li>
                                  );
                                })}
                              </ul>
                            </td>
                          );
                        })}
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex gap-4 overflow-x-auto overflow-y-hidden p-4 items-stretch">
          {stages.map((stage) => {
            const stageItems = itemsByStage(stage.id);
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
                  const raw = e.dataTransfer.getData('application/x-pipeline-item');
                  if (raw) {
                    try {
                      const { id } = JSON.parse(raw);
                      if (id) handleDrop(id, stage.id);
                    } catch (_) {}
                  }
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
                    {t('pipeline.leadsCount', { count: stageItems.length, defaultValue: String(stageItems.length) })}
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[120px]">
                  {stageItems.map((lead) => {
                    const isMoving = movingLeadId === lead.id;
                    const stageColorLead = stages.find((s) => s.id === lead.stage_id)?.color;
                    return (
                      <div
                        key={`lead-${lead.id}`}
                        draggable
                        onDragStart={(e) => {
                          setDraggingLeadId(lead.id);
                          e.dataTransfer.setData('application/x-pipeline-item', JSON.stringify({ kind: 'lead', id: lead.id }));
                          e.dataTransfer.effectAllowed = 'move';
                          if (dragPreviewRef.current) {
                            dragPreviewRef.current.textContent = leadContactName(lead);
                            e.dataTransfer.setDragImage(dragPreviewRef.current, 16, 12);
                          }
                        }}
                        onDragEnd={() => setDraggingLeadId(null)}
                        className={`bg-card rounded-lg p-3 border border-border shadow-soft cursor-grab active:cursor-grabbing flex flex-col gap-2 border-l-4 ${
                          draggingLeadId === lead.id ? 'opacity-50' : 'hover:shadow-soft-md hover:border-primary/30'
                        } ${isMoving ? 'animate-pulse' : ''}`}
                        style={stageColorLead ? { borderLeftColor: stageColorLead } : { borderLeftColor: 'rgb(16 185 129 / 0.8)' }}
                      >
                        <div className="flex items-start gap-2 min-w-0">
                          <GripVertical className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <Link
                              href={`/dashboard/messaging?contactId=${lead.contact_id}`}
                              className="font-semibold text-foreground hover:underline block truncate text-sm"
                            >
                              {leadContactName(lead)}
                            </Link>
                            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 mt-1">
                              {t('pipeline.leadCard', 'Лид')}
                            </span>
                          </div>
                          <div className="relative shrink-0">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setLeadMenuId(leadMenuId === lead.id ? null : lead.id);
                              }}
                              className="p-1 rounded text-muted-foreground hover:bg-accent"
                            >
                              <MoreVertical className="w-4 h-4" />
                            </button>
                            {leadMenuId === lead.id && (
                              <>
                                <div
                                  className="fixed inset-0 z-10"
                                  aria-hidden
                                  onClick={() => setLeadMenuId(null)}
                                />
                                <div className="absolute right-0 top-full mt-1 py-1 rounded-lg border border-border bg-card shadow-lg z-20 min-w-[160px]">
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveLead(lead.id)}
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
                  {stageItems.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground text-sm rounded-lg border border-dashed border-border">
                      {t('pipeline.noLeadsInStage', 'Нет лидов')}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {stages.length > 0 && leads.length === 0 && viewMode === 'kanban' && (
        <div className="m-4 p-6 rounded-xl border border-dashed border-border bg-muted/20 text-center">
          <p className="text-sm text-muted-foreground mb-2">{t('pipeline.noLeadsEmptyDesc', 'Добавьте лидов в воронку из контактов или мессенджера.')}</p>
          <Link href="/dashboard/crm">
            <Button variant="outline" size="sm">{t('pipeline.noLeadsCta')}</Button>
          </Link>
        </div>
      )}
      </div>

      <PipelineManageModal
        open={manageModalOpen}
        onClose={() => setManageModalOpen(false)}
        selectedPipelineId={selectedPipelineId}
        onPipelinesChange={loadPipelines}
        onStagesChange={loadStagesAndLeads}
      />
    </div>
  );
}
