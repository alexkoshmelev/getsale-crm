'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Calendar, UserCircle, Database, X, FileUp, UserPlus, Zap } from 'lucide-react';
import Button from '@/components/ui/Button';
import {
  updateCampaign,
  fetchCampaignAgents,
  fetchContactsForPicker,
  uploadAudienceFromCsv,
  fetchGroupSources,
  fetchGroupSourceContacts,
  type Campaign,
  type CampaignAgent,
  type ContactForPicker,
  type GroupSource,
} from '@/lib/api/campaigns';
import { clsx } from 'clsx';
import { fetchCompanies, type Company } from '@/lib/api/crm';
import { fetchPipelines, fetchStages, type Pipeline } from '@/lib/api/pipeline';
import { apiClient } from '@/lib/api/client';

interface CampaignAudienceScheduleProps {
  campaignId: string;
  campaign: Campaign;
  onUpdate: () => void;
}

const DAYS_OF_WEEK = [
  { value: 0, labelKey: 'campaigns.daySun' },
  { value: 1, labelKey: 'campaigns.dayMon' },
  { value: 2, labelKey: 'campaigns.dayTue' },
  { value: 3, labelKey: 'campaigns.dayWed' },
  { value: 4, labelKey: 'campaigns.dayThu' },
  { value: 5, labelKey: 'campaigns.dayFri' },
  { value: 6, labelKey: 'campaigns.daySat' },
];

export function CampaignAudienceSchedule({
  campaignId,
  campaign,
  onUpdate,
}: CampaignAudienceScheduleProps) {
  const { t } = useTranslation();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [saving, setSaving] = useState(false);
  const [companyId, setCompanyId] = useState<string>(() =>
    (campaign.target_audience?.filters as { companyId?: string })?.companyId ?? ''
  );
  const [pipelineId, setPipelineId] = useState<string>(() =>
    (campaign.target_audience?.filters as { pipelineId?: string })?.pipelineId ?? ''
  );
  const [hasTelegram, setHasTelegram] = useState<boolean>(() =>
    (campaign.target_audience?.filters as { hasTelegram?: boolean })?.hasTelegram !== false
  );
  const [limit, setLimit] = useState<number>(() =>
    campaign.target_audience?.limit ?? 1000
  );
  const [onlyNew, setOnlyNew] = useState<boolean>(() =>
    !!campaign.target_audience?.onlyNew
  );
  const [contactIds, setContactIds] = useState<string[]>(() =>
    Array.isArray(campaign.target_audience?.contactIds) ? campaign.target_audience!.contactIds! : []
  );
  const [bdAccountId, setBdAccountId] = useState<string>(() =>
    campaign.target_audience?.bdAccountId ?? ''
  );
  const [sendDelaySeconds, setSendDelaySeconds] = useState<number>(() =>
    campaign.target_audience?.sendDelaySeconds ?? 60
  );
  const [enrichContactsBeforeStart, setEnrichContactsBeforeStart] = useState<boolean>(() =>
    !!campaign.target_audience?.enrichContactsBeforeStart
  );
  type AudienceSource = 'database' | 'file' | 'group';
  const [audienceSource, setAudienceSource] = useState<AudienceSource>(() => {
    const s = (campaign.target_audience?.filters as { audienceSource?: AudienceSource })?.audienceSource;
    return s === 'file' || s === 'group' ? s : 'database';
  });
  const [agents, setAgents] = useState<CampaignAgent[]>([]);
  const [groupSources, setGroupSources] = useState<GroupSource[]>([]);
  const [csvLoading, setCsvLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [leadSectionOpen, setLeadSectionOpen] = useState(() => !!(campaign.lead_creation_settings?.trigger && (campaign.pipeline_id || campaign.lead_creation_settings)));
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [timezone, setTimezone] = useState<string>(() =>
    campaign.schedule?.timezone ?? 'Europe/Moscow'
  );
  const [workStart, setWorkStart] = useState<string>(() =>
    campaign.schedule?.workingHours?.start ?? '09:00'
  );
  const [workEnd, setWorkEnd] = useState<string>(() =>
    campaign.schedule?.workingHours?.end ?? '18:00'
  );
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(() =>
    campaign.schedule?.daysOfWeek ?? [1, 2, 3, 4, 5]
  );
  const lcs = campaign.lead_creation_settings;
  const [leadTrigger, setLeadTrigger] = useState<string>(() => lcs?.trigger ?? '');
  const [leadPipelineId, setLeadPipelineId] = useState<string>(() => campaign.pipeline_id ?? (lcs ? (campaign.pipeline_id ?? '') : ''));
  const [leadStageId, setLeadStageId] = useState<string>(() => lcs?.default_stage_id ?? '');
  const [leadResponsibleId, setLeadResponsibleId] = useState<string>(() => (lcs as { default_responsible_id?: string })?.default_responsible_id ?? '');
  const leadCreationEnabled = leadTrigger === 'on_first_send' || leadTrigger === 'on_reply';
  const [stages, setStages] = useState<{ id: string; name: string }[]>([]);
  const [teamMembers, setTeamMembers] = useState<{ user_id: string; email?: string; first_name?: string; last_name?: string }[]>([]);
  const isDraft = campaign.status === 'draft' || campaign.status === 'paused';

  useEffect(() => {
    if (leadPipelineId) fetchStages(leadPipelineId).then((s) => setStages(s.map((x) => ({ id: x.id, name: x.name })))).catch(() => setStages([]));
    else setStages([]);
  }, [leadPipelineId]);

  // Синхронизация настроек создания лида при загрузке/обновлении кампании.
  useEffect(() => {
    const nextTrigger = campaign.lead_creation_settings?.trigger ?? '';
    const nextPipelineId = campaign.pipeline_id ?? (campaign.lead_creation_settings ? (campaign.pipeline_id ?? '') : '');
    const nextStageId = campaign.lead_creation_settings?.default_stage_id ?? '';
    const nextResponsibleId = (campaign.lead_creation_settings as { default_responsible_id?: string })?.default_responsible_id ?? '';
    setLeadTrigger(nextTrigger);
    setLeadPipelineId(nextPipelineId);
    setLeadStageId(nextStageId);
    setLeadResponsibleId(nextResponsibleId);
    if (nextTrigger && nextPipelineId) setLeadSectionOpen(true);
  }, [campaign.id, campaign.pipeline_id, campaign.lead_creation_settings]);

  useEffect(() => {
    Promise.all([
      fetchCompanies({ limit: 200 }).then((r) => setCompanies(r.items)),
      fetchPipelines().then(setPipelines),
      fetchCampaignAgents().then(setAgents),
      fetchGroupSources().then(setGroupSources).catch(() => []),
      apiClient.get('/api/team/members').then((r) => {
        const list = Array.isArray(r.data) ? r.data : [];
        const seen = new Set<string>();
        setTeamMembers(list.filter((m: { user_id: string }) => {
          if (seen.has(m.user_id)) return false;
          seen.add(m.user_id);
          return true;
        }));
      }).catch(() => setTeamMembers([])),
    ]).catch(console.error);
  }, []);

  const toggleDay = (day: number) => {
    setDaysOfWeek((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateCampaign(campaignId, {
        targetAudience: {
          filters: {
            companyId: companyId || undefined,
            pipelineId: pipelineId || undefined,
            hasTelegram,
            audienceSource,
          },
          limit: Math.min(10000, Math.max(1, limit)),
          onlyNew: contactIds.length === 0 ? onlyNew : undefined,
          contactIds: contactIds.length > 0 ? contactIds : undefined,
          bdAccountId: bdAccountId || undefined,
          sendDelaySeconds: Math.max(0, Math.min(3600, sendDelaySeconds)),
          enrichContactsBeforeStart: enrichContactsBeforeStart || undefined,
        },
        // Расписание убрано из UI — не отправляем, чтобы отправки шли в любое время по задержке шага
        schedule: null,
        ...(leadTrigger && leadPipelineId
          ? {
              pipelineId: leadPipelineId,
              leadCreationSettings: {
                trigger: leadTrigger as 'on_first_send' | 'on_reply',
                default_stage_id: leadStageId || undefined,
                default_responsible_id: leadResponsibleId || undefined,
              },
            }
          : { leadCreationSettings: null }),
      });
      onUpdate();
    } catch (e) {
      console.error('Failed to save audience/schedule', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8 max-w-2xl">
      {/* 1. Источник контактов */}
      <section className="rounded-xl border border-border bg-card p-6">
        <h3 className="font-heading text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
          <Users className="w-5 h-5 text-primary" />
          {t('campaigns.audienceSource')}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          {(['database', 'file', 'group'] as const).map((src) => (
            <button
              key={src}
              type="button"
              onClick={() => isDraft && setAudienceSource(src)}
              disabled={!isDraft}
              className={clsx(
                'p-4 rounded-xl border-2 text-left transition-colors disabled:opacity-60',
                audienceSource === src
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted/30'
              )}
            >
              {src === 'database' && <Database className="w-6 h-6 text-primary mb-2" />}
              {src === 'file' && <FileUp className="w-6 h-6 text-primary mb-2" />}
              {src === 'group' && <Users className="w-6 h-6 text-primary mb-2" />}
              <span className="font-medium text-foreground block">
                {src === 'database' ? t('campaigns.sourceDatabase') : src === 'file' ? t('campaigns.sourceFile') : t('campaigns.sourceGroup')}
              </span>
            </button>
          ))}
        </div>

        {audienceSource === 'database' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={onlyNew && contactIds.length === 0} onChange={(e) => { setOnlyNew(e.target.checked); if (e.target.checked) setContactIds([]); }} disabled={!isDraft || contactIds.length > 0} className="rounded border-border" />
                <span className="text-sm text-foreground">{t('campaigns.onlyNew')}</span>
              </label>
              <Button type="button" variant="outline" size="sm" onClick={() => isDraft && setPickerOpen(true)} disabled={!isDraft}>
                <Database className="w-4 h-4 mr-1" />
                {t('campaigns.selectFromDatabase')}
              </Button>
              {contactIds.length > 0 && (
                <>
                  <span className="text-sm text-muted-foreground">{t('campaigns.contactsSelected', { count: contactIds.length })}</span>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setContactIds([])} disabled={!isDraft}>{t('campaigns.clearSelection')}</Button>
                </>
              )}
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" id="hasTelegram" checked={hasTelegram} onChange={(e) => setHasTelegram(e.target.checked)} disabled={!isDraft} className="rounded border-border" />
                <span className="text-sm text-foreground">{t('campaigns.filterHasTelegram')}</span>
              </label>
              <div className="flex items-center gap-2">
                <label className="text-sm text-foreground">{t('campaigns.audienceLimit')}</label>
                <input type="number" min={1} max={10000} value={limit} onChange={(e) => setLimit(parseInt(e.target.value, 10) || 1000)} disabled={!isDraft} className="w-24 px-2 py-1.5 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60" />
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer mt-2">
              <input type="checkbox" checked={enrichContactsBeforeStart} onChange={(e) => setEnrichContactsBeforeStart(e.target.checked)} disabled={!isDraft} className="rounded border-border" />
              <span className="text-sm text-foreground">{t('campaigns.enrichContactsBeforeStart', 'Перед запуском обогащать контакты из Telegram (имя, username)')}</span>
            </label>
          </div>
        )}

        {audienceSource === 'file' && (
          <div className="space-y-2">
            <input ref={csvInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file || !isDraft) return;
              setCsvLoading(true);
              try {
                const content = await file.text();
                const data = await uploadAudienceFromCsv(campaignId, { content, hasHeader: true });
                setContactIds(data.contactIds);
                setOnlyNew(false);
                onUpdate();
              } catch (err) { console.error('CSV import failed', err); }
              finally { setCsvLoading(false); e.target.value = ''; }
            }} />
            <Button type="button" variant="outline" disabled={!isDraft || csvLoading} onClick={() => csvInputRef.current?.click()}>
              <FileUp className="w-4 h-4 mr-2" />
              {csvLoading ? '...' : t('campaigns.uploadCsv')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('campaigns.uploadCsvHint')}</p>
            {contactIds.length > 0 && <p className="text-sm text-foreground">{t('campaigns.contactsSelected', { count: contactIds.length })}</p>}
          </div>
        )}

        {audienceSource === 'group' && groupSources.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t('campaigns.groupSourceHint')}</p>
            <select
              className="w-full sm:max-w-md px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              value=""
              onChange={async (e) => {
                const v = e.target.value;
                if (!v || !isDraft) return;
                const [bid, tid] = v.split('|');
                if (!bid || !tid) return;
                try {
                  const { contactIds: ids } = await fetchGroupSourceContacts({ bdAccountId: bid, telegramChatId: tid });
                  setContactIds(ids);
                  setOnlyNew(false);
                  onUpdate();
                } catch (err) { console.error('Group contacts failed', err); }
                e.target.value = '';
              }}
              disabled={!isDraft}
            >
              <option value="">{t('campaigns.selectGroup')}</option>
              {groupSources.map((g) => (
                <option key={`${g.bd_account_id}-${g.telegram_chat_id}`} value={`${g.bd_account_id}|${g.telegram_chat_id}`}>
                  {g.title || g.telegram_chat_id} ({g.account_name || ''})
                </option>
              ))}
            </select>
            {contactIds.length > 0 && <p className="text-sm text-foreground">{t('campaigns.contactsSelected', { count: contactIds.length })}</p>}
          </div>
        )}
        {audienceSource === 'group' && groupSources.length === 0 && <p className="text-sm text-muted-foreground">{t('campaigns.noGroupsSynced')}</p>}
      </section>

      {/* 2. Кто рассылает */}
      {agents.length > 0 && (
        <section className="rounded-xl border border-border bg-card p-6">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <UserCircle className="w-5 h-5 text-primary" />
            {t('campaigns.whoSends')}
          </h3>
          <div className="flex flex-wrap gap-3">
            {agents.map((a) => (
              <label
                key={a.id}
                className={clsx(
                  'flex items-center gap-2 cursor-pointer px-4 py-3 rounded-xl border-2 transition-colors',
                  bdAccountId === a.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50',
                  !isDraft && 'opacity-60 pointer-events-none'
                )}
              >
                <input type="radio" name="bdAccount" checked={bdAccountId === a.id} onChange={() => setBdAccountId(a.id)} disabled={!isDraft} className="sr-only" />
                <span className="text-sm font-medium text-foreground">{a.displayName}</span>
                <span className="text-xs text-muted-foreground">{t('campaigns.sentToday', { count: a.sentToday })}</span>
              </label>
            ))}
          </div>
          {agents.length > 0 && !bdAccountId && isDraft && <p className="text-xs text-muted-foreground mt-2">{t('campaigns.agentAny')}</p>}
        </section>
      )}

      {/* 4. Создание лида в CRM: галочка + когда/воронка/стадия */}
      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <button
          type="button"
          onClick={() => setLeadSectionOpen((o) => !o)}
          className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-muted/30 transition-colors"
        >
          <span className="font-heading text-base font-semibold text-foreground flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-muted-foreground" />
            {t('campaigns.leadCreationTitle')}
          </span>
          <span className="text-muted-foreground text-sm">{leadSectionOpen ? '▼' : '▶'}</span>
        </button>
        {leadSectionOpen && (
          <div className="px-6 pb-6 pt-0 space-y-4 border-t border-border">
            <label className="flex items-center gap-3 cursor-pointer py-2">
              <input
                type="checkbox"
                checked={leadCreationEnabled}
                onChange={(e) => {
                  if (e.target.checked) {
                    setLeadTrigger('on_first_send');
                    if (!leadPipelineId && pipelines.length > 0) setLeadPipelineId(pipelines[0].id);
                  } else {
                    setLeadTrigger('');
                  }
                }}
                disabled={!isDraft}
                className="h-4 w-4 rounded border-border text-primary focus:ring-ring"
              />
              <span className="font-medium text-foreground">{t('campaigns.leadCreationEnable')}</span>
            </label>
            {leadCreationEnabled && (
              <>
                <div>
                  <p className="text-sm font-medium text-foreground mb-2">{t('campaigns.leadCreationTrigger')}</p>
                  <div className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" name="leadTrigger" checked={leadTrigger === 'on_first_send'} onChange={() => setLeadTrigger('on_first_send')} disabled={!isDraft} className="border-border" />
                      <span className="text-sm text-foreground">{t('campaigns.leadCreationOnFirstSend')}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" name="leadTrigger" checked={leadTrigger === 'on_reply'} onChange={() => setLeadTrigger('on_reply')} disabled={!isDraft} className="border-border" />
                      <span className="text-sm text-foreground">{t('campaigns.leadCreationOnReply')}</span>
                    </label>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">{t('campaigns.leadCreationPipeline')}</label>
                    <select value={leadPipelineId} onChange={(e) => { setLeadPipelineId(e.target.value); setLeadStageId(''); }} disabled={!isDraft} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60">
                      <option value="">{t('campaigns.leadCreationSelectPipeline', 'Выберите воронку')}</option>
                      {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  {leadPipelineId && stages.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1">{t('campaigns.leadCreationStage')}</label>
                      <select value={leadStageId} onChange={(e) => setLeadStageId(e.target.value)} disabled={!isDraft} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60">
                        <option value="">{t('common.optional')}</option>
                        {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                  )}
                  {teamMembers.length > 0 && (
                    <div className="sm:col-span-2">
                      <label className="block text-sm font-medium text-foreground mb-1">{t('campaigns.leadCreationResponsible', 'Ответственный за лида')}</label>
                      <select value={leadResponsibleId} onChange={(e) => setLeadResponsibleId(e.target.value)} disabled={!isDraft} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60">
                        <option value="">{t('common.optional')}</option>
                        {teamMembers.map((m) => (
                          <option key={m.user_id} value={m.user_id}>
                            {[m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.user_id.slice(0, 8)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {isDraft && (
        <Button onClick={handleSave} disabled={saving}>
          {saving ? t('campaigns.saving') : t('common.save')}
        </Button>
      )}

      {pickerOpen && (
        <ContactPickerModal
          initialSelectedIds={contactIds}
          onAccept={(ids) => {
            setContactIds(ids);
            setPickerOpen(false);
            if (ids.length > 0) setOnlyNew(false);
          }}
          onClose={() => setPickerOpen(false)}
          t={t}
        />
      )}
    </div>
  );
}

function ContactPickerModal({
  initialSelectedIds,
  onAccept,
  onClose,
  t,
}: {
  initialSelectedIds: string[];
  onAccept: (ids: string[]) => void;
  onClose: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [contacts, setContacts] = useState<ContactForPicker[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [outreachFilter, setOutreachFilter] = useState<'all' | 'new' | 'in_outreach'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelectedIds));

  const load = useCallback(() => {
    setLoading(true);
    fetchContactsForPicker({
      limit: 500,
      outreachStatus: outreachFilter === 'all' ? undefined : outreachFilter,
      search: search.trim() || undefined,
    })
      .then(setContacts)
      .catch(() => setContacts([]))
      .finally(() => setLoading(false));
  }, [outreachFilter, search]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(contacts.map((c) => c.id)));
  };

  const clearAll = () => setSelected(new Set());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border border-border bg-card shadow-xl">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h3 className="font-heading text-lg font-semibold text-foreground">
            {t('campaigns.selectContactsFrom')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-muted text-muted-foreground"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 border-b border-border space-y-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('campaigns.searchContacts')}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex flex-wrap gap-2">
            {(['all', 'new', 'in_outreach'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setOutreachFilter(f)}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium',
                  outreachFilter === f
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                )}
              >
                {f === 'all' ? t('campaigns.filterAll') : f === 'new' ? t('campaigns.filterNew') : t('campaigns.filterInOutreach')}
              </button>
            ))}
            <button type="button" onClick={selectAll} className="text-sm text-primary hover:underline">
              {t('common.selectAll')}
            </button>
            <button type="button" onClick={clearAll} className="text-sm text-muted-foreground hover:underline">
              {t('common.clear')}
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto min-h-0">
          {loading ? (
            <div className="p-8 text-center text-muted-foreground">{t('common.loading')}</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/80 border-b border-border">
                <tr>
                  <th className="text-left w-10 p-2" />
                  <th className="text-left p-2 font-medium text-foreground min-w-[120px]">{t('common.name')}</th>
                  <th className="text-left p-2 font-medium text-foreground min-w-[100px]">Username</th>
                  <th className="text-left p-2 font-medium text-foreground min-w-[80px]">Telegram ID</th>
                  <th className="text-left p-2 font-medium text-foreground min-w-[140px]">Email</th>
                  <th className="text-left p-2 font-medium text-foreground min-w-[100px]">Телефон</th>
                  <th className="text-left p-2 font-medium text-foreground w-24">{t('campaigns.contactStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-border/50 hover:bg-muted/30"
                  >
                    <td className="p-2">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggle(c.id)}
                        className="rounded border-border"
                      />
                    </td>
                    <td className="p-2 text-foreground">
                      {(c.display_name || [c.first_name, c.last_name].filter(Boolean).join(' ')).trim() || (c.telegram_id ? `ID ${c.telegram_id}` : c.id.slice(0, 8))}
                    </td>
                    <td className="p-2 text-muted-foreground">{c.username ? `@${c.username.replace(/^@/, '')}` : (c.telegram_id ? `@${c.telegram_id}` : '—')}</td>
                    <td className="p-2 text-muted-foreground font-mono text-xs">{c.telegram_id ?? '—'}</td>
                    <td className="p-2 text-muted-foreground truncate max-w-[180px]" title={c.email ?? ''}>{c.email ?? '—'}</td>
                    <td className="p-2 text-muted-foreground">{c.phone ?? '—'}</td>
                    <td className="p-2">
                      <span className={clsx(
                        'text-xs px-2 py-0.5 rounded-full whitespace-nowrap',
                        c.outreach_status === 'new' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground'
                      )}>
                        {c.outreach_status === 'new' ? t('campaigns.statusNew') : t('campaigns.statusInOutreach')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="p-4 border-t border-border flex items-center justify-between gap-4">
          <span className="text-sm text-muted-foreground">
            {t('campaigns.contactsSelected', { count: selected.size })}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('common.close')}
            </Button>
            <Button onClick={() => onAccept(Array.from(selected))}>
              {t('common.accept')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
