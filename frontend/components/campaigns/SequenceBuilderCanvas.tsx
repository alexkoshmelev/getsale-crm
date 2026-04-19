'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Plus, MessageSquare, Clock, Pencil, Trash2, GripVertical, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  createCampaignTemplate,
  createCampaignSequenceStep,
  updateCampaignTemplate,
  updateCampaignSequenceStep,
  deleteCampaignSequenceStep,
  fetchMessagePresets,
  createMessagePreset,
  type CampaignTemplate,
  type CampaignSequenceStep,
  type MessagePreset,
} from '@/lib/api/campaigns';
import { fetchContacts, type Contact } from '@/lib/api/crm';
import { fetchPipelines, fetchStages, type Pipeline, type Stage } from '@/lib/api/pipeline';

interface SequenceBuilderCanvasProps {
  campaignId: string;
  campaignStatus: string;
  templates: CampaignTemplate[];
  sequences: CampaignSequenceStep[];
  onUpdate: () => void;
}

const CHANNELS: { value: string; labelKey: string }[] = [
  { value: 'telegram', labelKey: 'campaigns.channelTelegram' },
  { value: 'email', labelKey: 'campaigns.channelEmail' },
  { value: 'sms', labelKey: 'campaigns.channelSms' },
];

const VARIABLES = [
  '{{contact.first_name}}',
  '{{contact.last_name}}',
  '{{company.name}}',
];

function formatStepDelay(hours: number, minutes: number): string {
  const totalHours = hours + minutes / 60;
  if (totalHours >= 24) {
    const days = Math.round(totalHours / 24);
    return days === 1 ? '1 дн.' : `${days} дн.`;
  }
  if (hours > 0 && minutes > 0) return `${hours} ч ${minutes} мин`;
  if (minutes > 0) return `${minutes} мин`;
  return hours === 1 ? '1 ч' : `${hours} ч`;
}

/** Step delay slider: 1 min … 1 day, non-linear scale (fine at start). Stored as hours+minutes (seconds rounded on save). */
const STEP_DELAY_MIN_SEC = 60;
const STEP_DELAY_DEFAULT_MAX_SEC = 24 * 3600;
/** First segment ends at 10 min — slider uses ~40% width for high resolution. */
const STEP_DELAY_SEG1_END_SEC = 10 * 60;
/** Second segment ends at 2 h — next ~35% for minute steps. */
const STEP_DELAY_SEG2_END_SEC = 2 * 3600;
const STEP_DELAY_SLIDER_P1 = 0.4;
const STEP_DELAY_SLIDER_P2 = 0.75;

function secondsFromSliderPosition(p: number, maxSec: number): number {
  const T0 = STEP_DELAY_MIN_SEC;
  const T1 = STEP_DELAY_SEG1_END_SEC;
  const T2 = STEP_DELAY_SEG2_END_SEC;
  const T3 = Math.max(T2 + 60, maxSec);
  const clampedP = Math.min(1, Math.max(0, p));
  if (clampedP <= STEP_DELAY_SLIDER_P1) {
    const q = clampedP / STEP_DELAY_SLIDER_P1;
    return T0 + q * (T1 - T0);
  }
  if (clampedP <= STEP_DELAY_SLIDER_P2) {
    const q = (clampedP - STEP_DELAY_SLIDER_P1) / (STEP_DELAY_SLIDER_P2 - STEP_DELAY_SLIDER_P1);
    return T1 + q * (T2 - T1);
  }
  const q = (clampedP - STEP_DELAY_SLIDER_P2) / (1 - STEP_DELAY_SLIDER_P2);
  return T2 + q * (T3 - T2);
}

function sliderPositionFromSeconds(sec: number, maxSec: number): number {
  const T0 = STEP_DELAY_MIN_SEC;
  const T1 = STEP_DELAY_SEG1_END_SEC;
  const T2 = STEP_DELAY_SEG2_END_SEC;
  const T3 = Math.max(T2 + 60, maxSec);
  const s = Math.min(Math.max(sec, T0), T3);
  if (s <= T1) return STEP_DELAY_SLIDER_P1 * ((s - T0) / (T1 - T0));
  if (s <= T2) {
    return STEP_DELAY_SLIDER_P1 + (STEP_DELAY_SLIDER_P2 - STEP_DELAY_SLIDER_P1) * ((s - T1) / (T2 - T1));
  }
  return STEP_DELAY_SLIDER_P2 + (1 - STEP_DELAY_SLIDER_P2) * ((s - T2) / (T3 - T2));
}

/** Snap: 15s in first segment, 1 min in middle, 15 min at the end (hour-scale). */
function snapStepDelaySeconds(sec: number, maxSec: number): number {
  const raw = Math.min(maxSec, Math.max(STEP_DELAY_MIN_SEC, sec));
  if (raw <= STEP_DELAY_SEG1_END_SEC) return Math.round(raw / 15) * 15;
  if (raw <= STEP_DELAY_SEG2_END_SEC) return Math.round(raw / 60) * 60;
  return Math.round(raw / 900) * 900;
}

function ceilSnapForMaxDynamic(sec: number): number {
  const s = Math.max(0, sec);
  if (s <= STEP_DELAY_SEG1_END_SEC) return Math.ceil(s / 15) * 15;
  if (s <= STEP_DELAY_SEG2_END_SEC) return Math.ceil(s / 60) * 60;
  return Math.ceil(s / 900) * 900;
}

/** Readable label including seconds when relevant (UI only; API stores rounded minutes). */
function formatDelayFromSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const totalHours = s / 3600;
  if (totalHours >= 24) {
    const days = Math.round(totalHours / 24);
    return days === 1 ? '1 дн.' : `${days} дн.`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    if (m > 0 && sec > 0) return `${h} ч ${m} мин ${sec} сек`;
    if (m > 0) return `${h} ч ${m} мин`;
    if (sec > 0) return `${h} ч ${sec} сек`;
    return h === 1 ? '1 ч' : `${h} ч`;
  }
  if (m > 0 && sec > 0) return `${m} мин ${sec} сек`;
  if (m > 0) return `${m} мин`;
  if (sec > 0) return `${sec} сек`;
  return '1 мин';
}

function delayPartsFromTotalSeconds(totalSeconds: number): { delayHours: number; delayMinutes: number } {
  const mins = Math.max(1, Math.round(totalSeconds / 60));
  return { delayHours: Math.floor(mins / 60), delayMinutes: mins % 60 };
}

/** Step conditions (matches backend StepConditions). */
type ContactRule = {
  field: 'first_name' | 'last_name' | 'email' | 'phone' | 'telegram_id' | 'company_name';
  op: 'equals' | 'not_equals' | 'contains' | 'empty' | 'not_empty';
  value?: string;
};
type StepConditionsForm = {
  stopIfReplied?: boolean;
  contact?: ContactRule[];
  inPipelineStage?: { pipelineId: string; stageIds: string[] };
  notInPipelineStage?: { pipelineId: string; stageIds: string[] };
};

const CONTACT_FIELDS: { value: ContactRule['field']; labelKey: string }[] = [
  { value: 'first_name', labelKey: 'campaigns.conditionFieldFirstName' },
  { value: 'last_name', labelKey: 'campaigns.conditionFieldLastName' },
  { value: 'email', labelKey: 'campaigns.conditionFieldEmail' },
  { value: 'phone', labelKey: 'campaigns.conditionFieldPhone' },
  { value: 'telegram_id', labelKey: 'campaigns.conditionFieldTelegramId' },
  { value: 'company_name', labelKey: 'campaigns.conditionFieldCompanyName' },
];
const CONTACT_OPS: { value: ContactRule['op']; labelKey: string }[] = [
  { value: 'equals', labelKey: 'campaigns.conditionOpEquals' },
  { value: 'not_equals', labelKey: 'campaigns.conditionOpNotEquals' },
  { value: 'contains', labelKey: 'campaigns.conditionOpContains' },
  { value: 'empty', labelKey: 'campaigns.conditionOpEmpty' },
  { value: 'not_empty', labelKey: 'campaigns.conditionOpNotEmpty' },
];

function substituteVariables(
  content: string,
  contact: { first_name?: string | null; last_name?: string | null; company_name?: string | null; companyName?: string | null }
): string {
  const first = (contact.first_name ?? '').trim();
  const last = (contact.last_name ?? '').trim();
  const companyName = (contact.company_name ?? contact.companyName ?? '').trim();
  let out = content
    .replace(/\{\{contact\.first_name\}\}/g, first)
    .replace(/\{\{contact\.last_name\}\}/g, last)
    .replace(/\{\{company\.name\}\}/g, companyName);
  out = out.replace(/[ \t]+/g, ' ').replace(/\n +/g, '\n').replace(/ +\n/g, '\n').trim();
  return out;
}

export function SequenceBuilderCanvas({
  campaignId,
  campaignStatus,
  templates,
  sequences,
  onUpdate,
}: SequenceBuilderCanvasProps) {
  const { t } = useTranslation();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingStep, setEditingStep] = useState<CampaignSequenceStep | null>(null);
  const [saving, setSaving] = useState(false);
  const [formName, setFormName] = useState('');
  const [formChannel, setFormChannel] = useState('telegram');
  const [formContent, setFormContent] = useState('');
  /** Total delay for step (seconds); UI slider 1 min–1 day; saved as rounded minutes → hours/minutes. */
  const [formDelayTotalSeconds, setFormDelayTotalSeconds] = useState(STEP_DELAY_DEFAULT_MAX_SEC);
  const [formTriggerType, setFormTriggerType] = useState<'delay' | 'after_reply'>('delay');
  const [formStopIfReplied, setFormStopIfReplied] = useState(false);
  const [formContactConditions, setFormContactConditions] = useState<ContactRule[]>([]);
  const [formInPipelineStage, setFormInPipelineStage] = useState<{ pipelineId: string; stageIds: string[] } | null>(null);
  const [formNotInPipelineStage, setFormNotInPipelineStage] = useState<{ pipelineId: string; stageIds: string[] } | null>(null);
  const [draggedStepId, setDraggedStepId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [reordering, setReordering] = useState(false);

  const sortedSteps = [...(sequences || [])].sort((a, b) => a.order_index - b.order_index);
  const isDraft = campaignStatus === 'draft' || campaignStatus === 'paused';

  const openAdd = () => {
    setEditingStep(null);
    setFormName('');
    setFormChannel('telegram');
    setFormContent('');
    setFormDelayTotalSeconds(STEP_DELAY_DEFAULT_MAX_SEC);
    setFormTriggerType('delay');
    setFormStopIfReplied(false);
    setFormContactConditions([]);
    setFormInPipelineStage(null);
    setFormNotInPipelineStage(null);
    setModalOpen(true);
  };

  const openEdit = (step: CampaignSequenceStep) => {
    setEditingStep(step);
    setFormName(step.template_name || '');
    setFormChannel(step.channel || 'telegram');
    setFormContent(step.content || '');
    {
      const rawSec =
        (step.delay_hours ?? 0) * 3600 + (step.delay_minutes ?? 0) * 60;
      setFormDelayTotalSeconds(rawSec < STEP_DELAY_MIN_SEC ? STEP_DELAY_MIN_SEC : rawSec);
    }
    setFormTriggerType(step.trigger_type === 'after_reply' ? 'after_reply' : 'delay');
    const c = (step.conditions || {}) as StepConditionsForm;
    setFormStopIfReplied(!!c.stopIfReplied);
    setFormContactConditions(Array.isArray(c.contact) ? c.contact : []);
    setFormInPipelineStage(c.inPipelineStage?.pipelineId && c.inPipelineStage?.stageIds?.length
      ? { pipelineId: c.inPipelineStage.pipelineId, stageIds: [...c.inPipelineStage.stageIds] }
      : null);
    setFormNotInPipelineStage(c.notInPipelineStage?.pipelineId && c.notInPipelineStage?.stageIds?.length
      ? { pipelineId: c.notInPipelineStage.pipelineId, stageIds: [...c.notInPipelineStage.stageIds] }
      : null);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingStep(null);
  };

  const conditions: StepConditionsForm = {};
  if (formStopIfReplied) conditions.stopIfReplied = true;
  if (formContactConditions.length) conditions.contact = formContactConditions;

  const handleSave = async () => {
    const name = formName.trim();
    const content = formContent.trim();
    if (!name || content === undefined) return;
    setSaving(true);
    try {
      const { delayHours, delayMinutes } = delayPartsFromTotalSeconds(formDelayTotalSeconds);
      if (editingStep) {
        await updateCampaignTemplate(campaignId, editingStep.template_id, {
          name,
          channel: formChannel,
          content,
        });
        await updateCampaignSequenceStep(campaignId, editingStep.id, {
          delayHours,
          delayMinutes,
          conditions,
          triggerType: formTriggerType,
        });
      } else {
        const template = await createCampaignTemplate(campaignId, {
          name,
          channel: formChannel,
          content,
        });
        await createCampaignSequenceStep(campaignId, {
          orderIndex: sortedSteps.length,
          templateId: template.id,
          delayHours,
          delayMinutes,
          conditions,
          triggerType: formTriggerType,
        });
      }
      closeModal();
      onUpdate();
    } catch (e) {
      console.error('Failed to save step', e);
    } finally {
      setSaving(false);
    }
  };

  const handleDragStart = useCallback((e: React.DragEvent, stepId: string) => {
    setDraggedStepId(stepId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', stepId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedStepId) setDropIndex(index);
  }, [draggedStepId]);

  const handleDragLeave = useCallback(() => {
    setDropIndex(null);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    setDropIndex(null);
    const stepId = e.dataTransfer.getData('text/plain');
    if (!stepId || !draggedStepId || draggedStepId !== stepId) {
      setDraggedStepId(null);
      return;
    }
    const fromIndex = sortedSteps.findIndex((s) => s.id === stepId);
    if (fromIndex === -1 || fromIndex === toIndex) {
      setDraggedStepId(null);
      return;
    }
    setDraggedStepId(null);
    const reordered = [...sortedSteps];
    const [removed] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, removed);
    setReordering(true);
    try {
      await Promise.all(
        reordered.map((step, idx) =>
          updateCampaignSequenceStep(campaignId, step.id, { orderIndex: idx })
        )
      );
      onUpdate();
    } catch (err) {
      console.error('Failed to reorder steps', err);
    } finally {
      setReordering(false);
    }
  }, [campaignId, draggedStepId, sortedSteps, onUpdate]);

  const handleDragEnd = useCallback(() => {
    setDraggedStepId(null);
    setDropIndex(null);
  }, []);

  const handleDeleteStep = async (step: CampaignSequenceStep) => {
    if (!confirm(t('campaigns.deleteStep'))) return;
    try {
      await deleteCampaignSequenceStep(campaignId, step.id);
      onUpdate();
    } catch (e) {
      console.error('Failed to delete step', e);
    }
  };

  const handleToggleStepHidden = async (step: CampaignSequenceStep, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await updateCampaignSequenceStep(campaignId, step.id, {
        isHidden: !Boolean(step.is_hidden),
      });
      onUpdate();
    } catch (err) {
      console.error('Failed to toggle step visibility', err);
    }
  };

  const insertVariable = (v: string) => {
    setFormContent((prev) => prev + v);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="font-heading text-lg font-semibold text-foreground mb-1">
          {t('campaigns.sequenceBuilder')}
        </h2>
        <p className="text-sm text-muted-foreground mb-6">
          {t('campaigns.sequenceBuilderDesc')}
        </p>

        <div className="flex flex-col items-stretch max-w-2xl mx-auto">
          {sortedSteps.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-border bg-muted/20 p-10 text-center">
              <MessageSquare className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-4">
                {t('campaigns.noCampaignsDesc')}
              </p>
              {isDraft && (
                <Button onClick={openAdd}>
                  <Plus className="w-4 h-4 mr-2" />
                  {t('campaigns.addStep')}
                </Button>
              )}
            </div>
          ) : (
            <>
              {sortedSteps.map((step, index) => {
                const stepHidden = Boolean(step.is_hidden);
                return (
                <div
                  key={step.id}
                  className="flex flex-col items-center w-full max-w-2xl mx-auto"
                  onDragOver={isDraft ? (e) => handleDragOver(e, index) : undefined}
                  onDragLeave={isDraft ? handleDragLeave : undefined}
                  onDrop={isDraft ? (e) => handleDrop(e, index) : undefined}
                >
                  {dropIndex === index && (
                    <div className="w-full h-1 rounded-full bg-primary/50 mb-2" aria-hidden />
                  )}
                  <div
                    draggable={isDraft && !reordering}
                    onDragStart={isDraft ? (e) => handleDragStart(e, step.id) : undefined}
                    onDragEnd={isDraft ? handleDragEnd : undefined}
                    className={clsx(
                      'w-full rounded-xl border border-border bg-card overflow-hidden transition-shadow hover:shadow-soft',
                      isDraft && 'cursor-pointer',
                      draggedStepId === step.id && 'opacity-60',
                      stepHidden && 'opacity-60 border-dashed'
                    )}
                    onClick={() => isDraft && openEdit(step)}
                  >
                    <div className={clsx('p-4 flex items-start justify-between gap-4', stepHidden && 'line-through decoration-muted-foreground/80')}>
                      <div className="flex gap-3 min-w-0 flex-1">
                        {isDraft && (
                          <div
                            className="shrink-0 cursor-grab active:cursor-grabbing p-1 text-muted-foreground hover:text-foreground"
                            onClick={(e) => e.stopPropagation()}
                            onDragStart={(e) => handleDragStart(e, step.id)}
                          >
                            <GripVertical className="w-5 h-5" />
                          </div>
                        )}
                        <div className="rounded-lg bg-primary/10 p-2 h-fit shrink-0">
                          <MessageSquare className="w-5 h-5 text-primary" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="font-medium text-foreground">
                              {step.template_name || t('campaigns.stepMessage')}
                            </span>
                            <span className="text-xs px-2 py-0.5 rounded-md bg-muted text-muted-foreground capitalize">
                              {step.channel || 'telegram'}
                            </span>
                            {stepHidden && (
                              <span className="text-xs px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-400">
                                {t('campaigns.stepHiddenBadge', { defaultValue: 'Скрыто' })}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground line-clamp-2">
                            {(step.content || '').replace(/\{\{[^}]+\}\}/g, '…') || '—'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={(ev) => handleToggleStepHidden(step, ev)}
                          className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground"
                          title={stepHidden ? t('campaigns.showStep', { defaultValue: 'Показать в последовательности' }) : t('campaigns.hideStep', { defaultValue: 'Скрыть (не отправлять)' })}
                          aria-pressed={stepHidden}
                        >
                          {stepHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                        {isDraft && (
                          <>
                            <button
                              type="button"
                              onClick={() => openEdit(step)}
                              className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground"
                              title={t('campaigns.editStep')}
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteStep(step)}
                              className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                              title={t('campaigns.deleteStep')}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {index < sortedSteps.length - 1 && (
                      <div className="px-4 pb-2">
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 px-2.5 py-1 rounded-full">
                          {step.trigger_type === 'after_reply' ? (
                            <>
                              <MessageSquare className="w-3.5 h-3.5" />
                              {t('campaigns.stepTriggerAfterReply')}
                            </>
                          ) : (
                            <>
                              <Clock className="w-3.5 h-3.5" />
                              {formatStepDelay(step.delay_hours ?? 24, step.delay_minutes ?? 0)}
                            </>
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                  {index < sortedSteps.length - 1 && (
                    <div className="w-px h-6 bg-border shrink-0" aria-hidden />
                  )}
                </div>
              );
              })}
              {isDraft && (
                <>
                  <div className="w-px h-6 bg-border shrink-0" aria-hidden />
                  <Button variant="outline" onClick={openAdd} className="w-full max-w-md">
                    <Plus className="w-4 h-4 mr-2" />
                    {t('campaigns.addStep')}
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {modalOpen && (
        <StepEditModal
          isEdit={!!editingStep}
          name={formName}
          setName={setFormName}
          channel={formChannel}
          setChannel={setFormChannel}
          content={formContent}
          setContent={setFormContent}
          delayTotalSeconds={formDelayTotalSeconds}
          setDelayTotalSeconds={setFormDelayTotalSeconds}
          triggerType={formTriggerType}
          setTriggerType={setFormTriggerType}
          stopIfReplied={formStopIfReplied}
          setStopIfReplied={setFormStopIfReplied}
          contactConditions={formContactConditions}
          setContactConditions={setFormContactConditions}
          inPipelineStage={formInPipelineStage}
          setInPipelineStage={setFormInPipelineStage}
          notInPipelineStage={formNotInPipelineStage}
          setNotInPipelineStage={setFormNotInPipelineStage}
          onSave={handleSave}
          onClose={closeModal}
          saving={saving}
          onInsertVariable={insertVariable}
          t={t}
        />
      )}
    </div>
  );
}

function StepEditModal({
  isEdit,
  name,
  setName,
  channel,
  setChannel,
  content,
  setContent,
  delayTotalSeconds,
  setDelayTotalSeconds,
  triggerType,
  setTriggerType,
  stopIfReplied,
  setStopIfReplied,
  contactConditions,
  setContactConditions,
  inPipelineStage,
  setInPipelineStage,
  notInPipelineStage,
  setNotInPipelineStage,
  onSave,
  onClose,
  saving,
  onInsertVariable,
  t,
}: {
  isEdit: boolean;
  name: string;
  setName: (v: string) => void;
  channel: string;
  setChannel: (v: string) => void;
  content: string;
  setContent: (v: string) => void;
  delayTotalSeconds: number;
  setDelayTotalSeconds: (v: number) => void;
  triggerType: 'delay' | 'after_reply';
  setTriggerType: (v: 'delay' | 'after_reply') => void;
  stopIfReplied: boolean;
  setStopIfReplied: (v: boolean) => void;
  contactConditions: ContactRule[];
  setContactConditions: (v: ContactRule[] | ((prev: ContactRule[]) => ContactRule[])) => void;
  inPipelineStage: { pipelineId: string; stageIds: string[] } | null;
  setInPipelineStage: (v: { pipelineId: string; stageIds: string[] } | null) => void;
  notInPipelineStage: { pipelineId: string; stageIds: string[] } | null;
  setNotInPipelineStage: (v: { pipelineId: string; stageIds: string[] } | null) => void;
  onSave: () => void;
  onClose: () => void;
  saving: boolean;
  onInsertVariable: (v: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [presets, setPresets] = useState<MessagePreset[]>([]);
  const [savingPreset, setSavingPreset] = useState(false);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stagesForIn, setStagesForIn] = useState<Stage[]>([]);
  const [stagesForNotIn, setStagesForNotIn] = useState<Stage[]>([]);

  const stepDelayTrackRef = useRef<HTMLDivElement>(null);
  const [draggingStepDelay, setDraggingStepDelay] = useState(false);

  const stepDelayMaxSeconds = Math.max(
    STEP_DELAY_DEFAULT_MAX_SEC,
    ceilSnapForMaxDynamic(delayTotalSeconds)
  );

  const applyStepDelaySeconds = useCallback(
    (sec: number) => {
      const snapped = snapStepDelaySeconds(sec, stepDelayMaxSeconds);
      setDelayTotalSeconds(snapped);
    },
    [setDelayTotalSeconds, stepDelayMaxSeconds]
  );

  const stepDelaySecondsFromClientX = useCallback(
    (clientX: number) => {
      const el = stepDelayTrackRef.current;
      if (!el) return delayTotalSeconds;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return delayTotalSeconds;
      const p = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const raw = secondsFromSliderPosition(p, stepDelayMaxSeconds);
      return snapStepDelaySeconds(raw, stepDelayMaxSeconds);
    },
    [stepDelayMaxSeconds, delayTotalSeconds]
  );

  useEffect(() => {
    if (!draggingStepDelay) return;
    const onMove = (e: MouseEvent) => {
      applyStepDelaySeconds(stepDelaySecondsFromClientX(e.clientX));
    };
    const onUp = () => setDraggingStepDelay(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [draggingStepDelay, stepDelaySecondsFromClientX, applyStepDelaySeconds]);

  const stepDelaySliderP = sliderPositionFromSeconds(delayTotalSeconds, stepDelayMaxSeconds);

  useEffect(() => {
    fetchContacts({ limit: 100 })
      .then((r) => {
        setContacts(r.items);
        setContactsLoaded(true);
      })
      .catch(() => setContactsLoaded(true));
  }, []);
  useEffect(() => {
    fetchMessagePresets().then(setPresets).catch(() => setPresets([]));
  }, []);
  useEffect(() => {
    fetchPipelines().then(setPipelines).catch(() => setPipelines([]));
  }, []);
  useEffect(() => {
    if (inPipelineStage?.pipelineId) {
      fetchStages(inPipelineStage.pipelineId).then(setStagesForIn).catch(() => setStagesForIn([]));
    } else {
      setStagesForIn([]);
    }
  }, [inPipelineStage?.pipelineId]);
  useEffect(() => {
    if (notInPipelineStage?.pipelineId) {
      fetchStages(notInPipelineStage.pipelineId).then(setStagesForNotIn).catch(() => setStagesForNotIn([]));
    } else {
      setStagesForNotIn([]);
    }
  }, [notInPipelineStage?.pipelineId]);

  const sampleContact = {
    first_name: 'Иван',
    last_name: 'Иванов',
    company_name: 'ООО Пример',
    companyName: 'ООО Пример',
  };
  const previewText = content
    ? substituteVariables(content, sampleContact)
    : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-lg rounded-2xl border border-border bg-card shadow-xl max-h-[90vh] flex flex-col">
        <div className="p-6 border-b border-border">
          <h3 className="font-heading text-lg font-semibold text-foreground">
            {isEdit ? t('campaigns.editStep') : t('campaigns.addStep')}
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t('campaigns.templateName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('campaigns.stepMessage')}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t('campaigns.stepChannel')}
            </label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              {CHANNELS.map((ch) => (
                <option key={ch.value} value={ch.value}>
                  {t(ch.labelKey)}
                </option>
              ))}
            </select>
          </div>
          <div>
            {presets.length > 0 && (
              <div className="mb-2">
                <label className="block text-sm font-medium text-foreground mb-1">
                  {t('campaigns.messagePreset')}
                </label>
                <div className="flex gap-2">
                  <select
                    value=""
                    onChange={(e) => {
                      const id = e.target.value;
                      if (!id) return;
                      const p = presets.find((x) => x.id === id);
                      if (p) {
                        setContent(p.content);
                        if (!name.trim()) setName(p.name);
                      }
                      e.target.value = '';
                    }}
                    className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    <option value="">{t('campaigns.selectPreset')}</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={savingPreset || !content.trim()}
                    onClick={async () => {
                      if (!content.trim()) return;
                      setSavingPreset(true);
                      try {
                        await createMessagePreset({
                          name: name.trim() || `Preset ${new Date().toLocaleDateString()}`,
                          channel,
                          content,
                        });
                        const list = await fetchMessagePresets();
                        setPresets(list);
                      } catch (err) {
                        console.error('Failed to save preset', err);
                      } finally {
                        setSavingPreset(false);
                      }
                    }}
                  >
                    {savingPreset ? t('campaigns.saving') : t('campaigns.saveAsPreset')}
                  </Button>
                </div>
              </div>
            )}
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t('campaigns.templateContent')}
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t('campaigns.templateContentPlaceholder')}
              rows={5}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring resize-y"
            />
            <p className="text-xs text-muted-foreground mt-1.5 mb-2">
              {t('campaigns.variablesHint')}
            </p>
            <div className="flex flex-wrap gap-2">
              {VARIABLES.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => onInsertVariable(v)}
                  className="text-xs px-2.5 py-1 rounded-md bg-muted hover:bg-muted/80 text-foreground"
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-4 border border-border rounded-lg p-4 bg-muted/20">
            <div className="text-sm font-semibold text-foreground">
              {t('campaigns.nextMessageSection')}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="stopIfReplied"
                checked={stopIfReplied}
                onChange={(e) => setStopIfReplied(e.target.checked)}
                className="rounded border-border"
              />
              <label htmlFor="stopIfReplied" className="text-sm text-foreground">
                {t('campaigns.conditionStopIfReplied')}
              </label>
            </div>
            <div>
              <div className="text-sm font-medium text-foreground mb-2">
                {t('campaigns.nextMessageWhen')}
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="triggerType"
                    checked={triggerType === 'delay'}
                    onChange={() => setTriggerType('delay')}
                    className="border-border"
                  />
                  <span className="text-sm text-foreground">{t('campaigns.stepTriggerDelay')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="triggerType"
                    checked={triggerType === 'after_reply'}
                    onChange={() => setTriggerType('after_reply')}
                    className="border-border"
                  />
                  <span className="text-sm text-foreground">{t('campaigns.stepTriggerAfterReply')}</span>
                </label>
              </div>
              {triggerType === 'delay' && (
                <>
                  <label className="block text-sm font-medium text-foreground mt-2 mb-1.5">
                    {t('campaigns.stepDelay')}
                  </label>
                  <div
                    ref={stepDelayTrackRef}
                    className="relative h-8 mt-1"
                    onMouseDown={(e) => {
                      applyStepDelaySeconds(stepDelaySecondsFromClientX(e.clientX));
                    }}
                  >
                    <div className="absolute top-1/2 -translate-y-1/2 h-1.5 w-full rounded-full bg-muted/60" />
                    <div
                      className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-primary"
                      style={{
                        left: 0,
                        width: `${stepDelaySliderP * 100}%`,
                      }}
                    />
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDraggingStepDelay(true);
                      }}
                      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-primary border-2 border-background shadow"
                      style={{
                        left: `${stepDelaySliderP * 100}%`,
                        zIndex: draggingStepDelay ? 40 : 20,
                      }}
                      aria-label={t('campaigns.stepDelaySliderAria')}
                      aria-valuemin={STEP_DELAY_MIN_SEC}
                      aria-valuemax={stepDelayMaxSeconds}
                      aria-valuenow={delayTotalSeconds}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground -mt-1">
                    <span>{t('campaigns.stepDelaySliderMin')}</span>
                    <span>
                      {stepDelayMaxSeconds <= STEP_DELAY_DEFAULT_MAX_SEC
                        ? t('campaigns.stepDelaySliderMax1d')
                        : formatDelayFromSeconds(stepDelayMaxSeconds)}
                    </span>
                  </div>
                  <p className="text-sm text-foreground mt-1">
                    {formatDelayFromSeconds(delayTotalSeconds)}
                  </p>
                </>
              )}
            </div>
            <details className="mt-2">
              <summary className="text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground">
                {t('campaigns.conditionsContactExtra')}
              </summary>
              <div className="mt-2 space-y-2">
                {contactConditions.map((rule, idx) => (
                  <div key={idx} className="flex flex-wrap items-center gap-2 mb-2">
                    <select
                      value={rule.field}
                      onChange={(e) => setContactConditions((prev) => {
                        const next = [...prev];
                        next[idx] = { ...next[idx]!, field: e.target.value as ContactRule['field'] };
                        return next;
                      })}
                      className="px-2 py-1.5 rounded border border-border bg-background text-foreground text-sm"
                    >
                      {CONTACT_FIELDS.map((f) => (
                        <option key={f.value} value={f.value}>{t(f.labelKey)}</option>
                      ))}
                    </select>
                    <select
                      value={rule.op}
                      onChange={(e) => setContactConditions((prev) => {
                        const next = [...prev];
                        next[idx] = { ...next[idx]!, op: e.target.value as ContactRule['op'] };
                        return next;
                      })}
                      className="px-2 py-1.5 rounded border border-border bg-background text-foreground text-sm"
                    >
                      {CONTACT_OPS.map((o) => (
                        <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
                      ))}
                    </select>
                    {(rule.op !== 'empty' && rule.op !== 'not_empty') && (
                      <input
                        type="text"
                        value={rule.value ?? ''}
                        onChange={(e) => setContactConditions((prev) => {
                          const next = [...prev];
                          next[idx] = { ...next[idx]!, value: e.target.value };
                          return next;
                        })}
                        placeholder={t('campaigns.conditionValue', { defaultValue: 'Значение' })}
                        className="flex-1 min-w-[80px] px-2 py-1.5 rounded border border-border bg-background text-foreground text-sm"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => setContactConditions((prev) => prev.filter((_, i) => i !== idx))}
                      className="p-1.5 rounded border border-border hover:bg-muted text-muted-foreground"
                      aria-label={t('common.delete')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setContactConditions((prev) => [...prev, { field: 'first_name', op: 'equals', value: '' }])}
                  className="flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  <Plus className="w-4 h-4" />
                  {t('campaigns.conditionAddContact', { defaultValue: 'Добавить правило по полю' })}
                </button>
              </div>
            </details>
          </div>
          <div className="border-t border-border pt-4">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground mb-1.5">
              <Eye className="w-4 h-4" />
              {t('campaigns.preview')} (Иванов Иван)
            </label>
            {previewText !== '' && (
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground whitespace-pre-wrap">
                {previewText}
              </div>
            )}
          </div>
        </div>
        <div className="p-6 border-t border-border flex justify-end gap-2">
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
