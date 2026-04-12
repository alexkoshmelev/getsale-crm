'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { UserCircle, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  updateCampaign,
  fetchCampaignAgents,
  type Campaign,
  type CampaignAgent,
} from '@/lib/api/campaigns';
import { clsx } from 'clsx';
import { fetchPipelines, fetchStages, type Pipeline } from '@/lib/api/pipeline';
import { apiClient } from '@/lib/api/client';
import { AccountStatusAvatar } from '@/components/bd-accounts/AccountStatusAvatar';
import { campaignBdAccountToBDAccount } from '@/lib/campaign-bd-account';
import { isFloodActive } from '@/lib/bd-account-health';

interface CampaignAudienceScheduleProps {
  campaignId: string;
  campaign: Campaign;
  onUpdate: () => void;
}

function formatSeconds(value: number): string {
  const v = Math.max(0, Math.floor(value));
  const m = Math.floor(v / 60);
  const s = v % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const DELAY_MIN_SECONDS = 60;
const DELAY_MAX_SECONDS = 3600;
const DELAY_DEFAULT_MIN_SECONDS = 180;
const DELAY_DEFAULT_MAX_SECONDS = 300;

const DAILY_SEND_MIN = 1;
const DAILY_SEND_MAX = 500;
const DAILY_SEND_PLACEHOLDER = 20;

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
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [saving, setSaving] = useState(false);
  const [companyId, setCompanyId] = useState<string>(() =>
    (campaign.target_audience?.filters as { companyId?: string })?.companyId ?? ''
  );
  const [pipelineId, setPipelineId] = useState<string>(() =>
    (campaign.target_audience?.filters as { pipelineId?: string })?.pipelineId ?? ''
  );
  // contactIds are now stored in campaign_participants, not in target_audience
  const contactIds: string[] = [];
  const [bdAccountIds, setBdAccountIds] = useState<string[]>(() => {
    const ids = campaign.target_audience?.bdAccountIds;
    if (Array.isArray(ids) && ids.length > 0) return ids.filter((x) => typeof x === 'string');
    const single = campaign.target_audience?.bdAccountId;
    return single ? [single] : [];
  });
  const [sendDelayMinSeconds, setSendDelayMinSeconds] = useState<number>(() => {
    const legacy = campaign.target_audience?.sendDelaySeconds;
    const raw = campaign.target_audience?.sendDelayMinSeconds ?? (legacy != null ? legacy : DELAY_DEFAULT_MIN_SECONDS);
    return Math.max(DELAY_MIN_SECONDS, Math.min(DELAY_MAX_SECONDS, Math.floor(raw)));
  });
  const [sendDelayMaxSeconds, setSendDelayMaxSeconds] = useState<number>(() => {
    const legacy = campaign.target_audience?.sendDelaySeconds;
    const raw = campaign.target_audience?.sendDelayMaxSeconds ?? (legacy != null ? legacy : DELAY_DEFAULT_MAX_SECONDS);
    const clamped = Math.max(DELAY_MIN_SECONDS, Math.min(DELAY_MAX_SECONDS, Math.floor(raw)));
    return Math.max(clamped, sendDelayMinSeconds);
  });
  type AudienceSource = 'database' | 'file' | 'group';
  const [audienceSource, setAudienceSource] = useState<AudienceSource>(() => {
    const s = (campaign.target_audience?.filters as { audienceSource?: AudienceSource })?.audienceSource;
    return s === 'file' || s === 'group' ? s : 'database';
  });
  const [agents, setAgents] = useState<CampaignAgent[]>([]);
  const delayTrackRef = useRef<HTMLDivElement | null>(null);
  const [draggingDelayThumb, setDraggingDelayThumb] = useState<'min' | 'max' | null>(null);
  const [leadSectionOpen, setLeadSectionOpen] = useState(() => !!(campaign.lead_creation_settings?.trigger && (campaign.pipeline_id || campaign.lead_creation_settings)));
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
  const [randomizeWithAI, setRandomizeWithAI] = useState<boolean>(() =>
    !!(campaign.target_audience as { randomizeWithAI?: boolean } | undefined)?.randomizeWithAI
  );
  const [enrichBeforeStart, setEnrichBeforeStart] = useState<boolean>(() =>
    !!(campaign.target_audience as { enrichContactsBeforeStart?: boolean } | undefined)?.enrichContactsBeforeStart
  );
  const [dailySendTarget, setDailySendTarget] = useState<string>(() => {
    const raw = campaign.target_audience?.dailySendTarget;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return String(Math.min(DAILY_SEND_MAX, Math.max(DAILY_SEND_MIN, Math.floor(raw))));
    }
    return '';
  });
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
    const raw = campaign.target_audience?.dailySendTarget;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      setDailySendTarget(String(Math.min(DAILY_SEND_MAX, Math.max(DAILY_SEND_MIN, Math.floor(raw)))));
    } else {
      setDailySendTarget('');
    }
  }, [campaign.id, campaign.target_audience?.dailySendTarget]);

  useEffect(() => {
    setEnrichBeforeStart(!!campaign.target_audience?.enrichContactsBeforeStart);
  }, [campaign.id, campaign.target_audience?.enrichContactsBeforeStart]);

  useEffect(() => {
    Promise.all([
      fetchPipelines().then(setPipelines),
      fetchCampaignAgents().then(setAgents),
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

  type LeadOverrides = { leadTrigger?: string; leadPipelineId?: string; leadStageId?: string; leadResponsibleId?: string };
  const saveAudience = useCallback(async (overrides?: {
    audienceSource?: AudienceSource;
    bdAccountId?: string;
    bdAccountIds?: string[];
    randomizeWithAI?: boolean;
    enrichContactsBeforeStart?: boolean;
    sendDelaySeconds?: number;
    sendDelayMinSeconds?: number;
    sendDelayMaxSeconds?: number;
    dailySendTarget?: number | null;
  } & LeadOverrides) => {
    const src = overrides?.audienceSource ?? audienceSource;
    const accIds = overrides?.bdAccountIds ?? (overrides?.bdAccountId !== undefined ? [overrides.bdAccountId!] : bdAccountIds);
    const randomizeAI = overrides?.randomizeWithAI ?? randomizeWithAI;
    const enrich = overrides?.enrichContactsBeforeStart ?? enrichBeforeStart;
    const delayMin = Math.max(DELAY_MIN_SECONDS, Math.min(DELAY_MAX_SECONDS, Math.floor(overrides?.sendDelayMinSeconds ?? sendDelayMinSeconds)));
    const delayMax = Math.max(delayMin, Math.min(DELAY_MAX_SECONDS, Math.floor(overrides?.sendDelayMaxSeconds ?? sendDelayMaxSeconds)));
    const dailyParsed: number | undefined = (() => {
      if (overrides && 'dailySendTarget' in overrides) {
        const d = overrides.dailySendTarget;
        if (d === null || d === undefined) return undefined;
        return Math.min(DAILY_SEND_MAX, Math.max(DAILY_SEND_MIN, Math.floor(Number(d))));
      }
      const t = dailySendTarget.trim();
      if (t === '') return undefined;
      const n = Math.floor(Number(t));
      if (!Number.isFinite(n) || n < DAILY_SEND_MIN) return undefined;
      return Math.min(DAILY_SEND_MAX, n);
    })();
    const trigger = overrides?.leadTrigger ?? leadTrigger;
    const pipeline = overrides?.leadPipelineId ?? leadPipelineId;
    const stage = overrides?.leadStageId ?? leadStageId;
    const responsible = overrides?.leadResponsibleId ?? leadResponsibleId;
    setSaving(true);
    try {
      await updateCampaign(campaignId, {
        targetAudience: {
          filters: {
            companyId: companyId || undefined,
            pipelineId: pipelineId || undefined,
            audienceSource: src,
          },
          limit: 10000,
          bdAccountId: accIds.length === 1 ? accIds[0] : undefined,
          bdAccountIds: accIds.length > 0 ? accIds : undefined,
          sendDelaySeconds: delayMin,
          sendDelayMinSeconds: delayMin,
          sendDelayMaxSeconds: delayMax,
          randomizeWithAI: randomizeAI,
          enrichContactsBeforeStart: enrich,
          ...(dailyParsed !== undefined ? { dailySendTarget: dailyParsed } : {}),
        },
        schedule: null,
        ...(trigger && pipeline
          ? {
              pipelineId: pipeline,
              leadCreationSettings: {
                trigger: trigger as 'on_first_send' | 'on_reply',
                default_stage_id: stage || undefined,
                default_responsible_id: responsible || undefined,
              },
            }
          : { pipelineId: null, leadCreationSettings: null }),
      });
      onUpdate();
    } catch (e) {
      console.error('Failed to save audience/schedule', e);
    } finally {
      setSaving(false);
    }
  }, [campaignId, audienceSource, bdAccountIds, companyId, pipelineId, sendDelayMinSeconds, sendDelayMaxSeconds, dailySendTarget, randomizeWithAI, leadTrigger, leadPipelineId, leadStageId, leadResponsibleId, onUpdate, t]);

  const percentFromSeconds = (seconds: number): number =>
    ((seconds - DELAY_MIN_SECONDS) / (DELAY_MAX_SECONDS - DELAY_MIN_SECONDS)) * 100;

  const secondsFromClientX = useCallback((clientX: number): number => {
    const el = delayTrackRef.current;
    if (!el) return sendDelayMinSeconds;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(DELAY_MIN_SECONDS + ratio * (DELAY_MAX_SECONDS - DELAY_MIN_SECONDS));
  }, [sendDelayMinSeconds]);

  useEffect(() => {
    if (!draggingDelayThumb || !isDraft) return;
    const onMove = (e: MouseEvent) => {
      const v = secondsFromClientX(e.clientX);
      if (draggingDelayThumb === 'min') {
        setSendDelayMinSeconds(Math.min(v, sendDelayMaxSeconds));
      } else {
        setSendDelayMaxSeconds(Math.max(v, sendDelayMinSeconds));
      }
    };
    const onUp = () => {
      setDraggingDelayThumb(null);
      saveAudience({ sendDelayMinSeconds, sendDelayMaxSeconds });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [draggingDelayThumb, isDraft, saveAudience, secondsFromClientX, sendDelayMaxSeconds, sendDelayMinSeconds]);

  return (
    <div className="space-y-8 max-w-3xl">
      <div className="space-y-8">
      {/* 2. Кто рассылает */}
      {agents.length > 0 && (
        <section className="rounded-xl border border-border bg-card p-6">
          <h3 className="font-heading text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <UserCircle className="w-5 h-5 text-primary" />
            {t('campaigns.whoSends')}
          </h3>
          <div className="flex flex-wrap gap-3">
            {agents.map((a) => {
              const checked = bdAccountIds.includes(a.id);
              return (
                <label
                  key={a.id}
                  className={clsx(
                    'flex items-start gap-2 cursor-pointer px-4 py-3 rounded-xl border-2 transition-colors',
                    checked ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50',
                    !isDraft && 'opacity-60 pointer-events-none'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const next = checked ? bdAccountIds.filter((id) => id !== a.id) : [...bdAccountIds, a.id];
                      setBdAccountIds(next);
                      saveAudience({ bdAccountIds: next });
                    }}
                    disabled={!isDraft}
                    className="sr-only"
                  />
                  <div className="shrink-0 pt-0.5">
                    <AccountStatusAvatar accountId={a.id} account={a} size="sm" showTooltip />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-medium text-foreground truncate">{a.displayName}</span>
                    {isFloodActive(campaignBdAccountToBDAccount(a)) && (
                      <span className="text-[10px] text-amber-600 dark:text-amber-400">{t('campaigns.accountFlood')}</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">{t('campaigns.sentToday', { count: a.sentToday })}</span>
                </label>
              );
            })}
          </div>
          {agents.length > 0 && bdAccountIds.length === 0 && isDraft && <p className="text-xs text-muted-foreground mt-2">{t('campaigns.agentAny')}</p>}
        </section>
      )}

      {/* 3. Задержка между отправками */}
      <section className="rounded-xl border border-border bg-card p-6">
        <h3 className="text-sm font-semibold text-foreground mb-1">{t('campaigns.sendDelayLabel')}</h3>
        <p className="text-xs text-muted-foreground mb-3">{t('campaigns.sendDelayHint')}</p>
        <div className="space-y-4">
          <div
            ref={delayTrackRef}
            className="relative h-8"
            onMouseDown={(e) => {
              if (!isDraft) return;
              const v = secondsFromClientX(e.clientX);
              const distToMin = Math.abs(v - sendDelayMinSeconds);
              const distToMax = Math.abs(v - sendDelayMaxSeconds);
              if (distToMin <= distToMax) {
                const nextMin = Math.min(v, sendDelayMaxSeconds);
                setSendDelayMinSeconds(nextMin);
                saveAudience({ sendDelayMinSeconds: nextMin, sendDelayMaxSeconds });
              } else {
                const nextMax = Math.max(v, sendDelayMinSeconds);
                setSendDelayMaxSeconds(nextMax);
                saveAudience({ sendDelayMinSeconds, sendDelayMaxSeconds: nextMax });
              }
            }}
          >
            <div className="absolute top-1/2 -translate-y-1/2 h-1.5 w-full rounded-full bg-muted/60" />
            <div
              className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-primary"
              style={{
                left: `${percentFromSeconds(sendDelayMinSeconds)}%`,
                right: `${100 - percentFromSeconds(sendDelayMaxSeconds)}%`,
              }}
            />
            <button
              type="button"
              disabled={!isDraft}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDraggingDelayThumb('min');
              }}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-primary border-2 border-background shadow"
              style={{ left: `${percentFromSeconds(sendDelayMinSeconds)}%`, zIndex: draggingDelayThumb === 'min' ? 40 : 20 }}
              aria-label="Delay min"
            />
            <button
              type="button"
              disabled={!isDraft}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDraggingDelayThumb('max');
              }}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-primary border-2 border-background shadow"
              style={{ left: `${percentFromSeconds(sendDelayMaxSeconds)}%`, zIndex: draggingDelayThumb === 'max' ? 40 : 30 }}
              aria-label="Delay max"
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground -mt-1">
            <span>{formatSeconds(DELAY_MIN_SECONDS)}</span>
            <span>{formatSeconds(DELAY_MAX_SECONDS)}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {`Range: ${formatSeconds(sendDelayMinSeconds)} - ${formatSeconds(sendDelayMaxSeconds)}`}
          </p>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-6">
        <h3 className="text-sm font-semibold text-foreground mb-1">{t('campaigns.dailySendLimit')}</h3>
        <p className="text-xs text-muted-foreground mb-3">{t('campaigns.dailySendLimitHint')}</p>
        <input
          type="number"
          min={DAILY_SEND_MIN}
          max={DAILY_SEND_MAX}
          placeholder={String(DAILY_SEND_PLACEHOLDER)}
          value={dailySendTarget}
          onChange={(e) => {
            if (!isDraft) return;
            setDailySendTarget(e.target.value);
          }}
          onBlur={() => {
            if (!isDraft) return;
            const t = dailySendTarget.trim();
            if (t === '') {
              saveAudience({ dailySendTarget: null });
              return;
            }
            const n = Math.floor(Number(t));
            if (!Number.isFinite(n) || n < DAILY_SEND_MIN) {
              setDailySendTarget('');
              saveAudience({ dailySendTarget: null });
              return;
            }
            const clamped = Math.min(DAILY_SEND_MAX, Math.max(DAILY_SEND_MIN, n));
            setDailySendTarget(String(clamped));
            saveAudience({ dailySendTarget: clamped });
          }}
          disabled={!isDraft}
          className="w-full max-w-[200px] px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
        />
      </section>

      {/* 4. AI и опции */}
      <section className="rounded-xl border border-border bg-card p-6">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enrichBeforeStart}
            onChange={(e) => {
              const checked = e.target.checked;
              setEnrichBeforeStart(checked);
              saveAudience({ enrichContactsBeforeStart: checked });
            }}
            disabled={!isDraft}
            className="h-4 w-4 rounded border-border text-primary focus:ring-ring"
          />
          <span className="text-sm font-medium text-foreground">{t('campaigns.enrichContactsBeforeStart')}</span>
        </label>
        <p className="text-xs text-muted-foreground mt-2 pl-7 max-w-xl">{t('campaigns.enrichContactsBeforeStartHint')}</p>
        <label className="flex items-center gap-3 cursor-pointer mt-4">
          <input
            type="checkbox"
            checked={randomizeWithAI}
            onChange={(e) => {
              const checked = e.target.checked;
              setRandomizeWithAI(checked);
              saveAudience({ randomizeWithAI: checked });
            }}
            disabled={!isDraft}
            className="h-4 w-4 rounded border-border text-primary focus:ring-ring"
          />
          <span className="text-sm font-medium text-foreground">{t('campaigns.randomizeWithAI')}</span>
        </label>
      </section>

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
                    const nextPipeline = leadPipelineId || (pipelines.length > 0 ? pipelines[0].id : '');
                    setLeadTrigger('on_first_send');
                    if (!leadPipelineId && pipelines.length > 0) setLeadPipelineId(pipelines[0].id);
                    saveAudience({ leadTrigger: 'on_first_send', leadPipelineId: nextPipeline });
                  } else {
                    setLeadTrigger('');
                    saveAudience({ leadTrigger: '', leadPipelineId: '', leadStageId: '', leadResponsibleId: '' });
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
                      <input type="radio" name="leadTrigger" checked={leadTrigger === 'on_first_send'} onChange={() => { setLeadTrigger('on_first_send'); saveAudience({ leadTrigger: 'on_first_send' }); }} disabled={!isDraft} className="border-border" />
                      <span className="text-sm text-foreground">{t('campaigns.leadCreationOnFirstSend')}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" name="leadTrigger" checked={leadTrigger === 'on_reply'} onChange={() => { setLeadTrigger('on_reply'); saveAudience({ leadTrigger: 'on_reply' }); }} disabled={!isDraft} className="border-border" />
                      <span className="text-sm text-foreground">{t('campaigns.leadCreationOnReply')}</span>
                    </label>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">{t('campaigns.leadCreationPipeline')}</label>
                    <select value={leadPipelineId} onChange={(e) => {
                      const v = e.target.value;
                      setLeadPipelineId(v);
                      setLeadStageId('');
                      saveAudience({ leadPipelineId: v, leadStageId: '' });
                    }} disabled={!isDraft} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60">
                      <option value="">{t('campaigns.leadCreationSelectPipeline')}</option>
                      {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  {leadPipelineId && stages.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1">{t('campaigns.leadCreationStage')}</label>
                      <select value={leadStageId} onChange={(e) => { const v = e.target.value; setLeadStageId(v); saveAudience({ leadStageId: v }); }} disabled={!isDraft} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60">
                        <option value="">{t('common.optional')}</option>
                        {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                  )}
                  {teamMembers.length > 0 && (
                    <div className="sm:col-span-2">
                      <label className="block text-sm font-medium text-foreground mb-1">{t('campaigns.leadCreationResponsible')}</label>
                      <select value={leadResponsibleId} onChange={(e) => { const v = e.target.value; setLeadResponsibleId(v); saveAudience({ leadResponsibleId: v }); }} disabled={!isDraft} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60">
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
      </div>
    </div>
  );
}

