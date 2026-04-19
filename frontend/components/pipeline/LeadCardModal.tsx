'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import Link from 'next/link';
import { MessageSquare, ExternalLink, Loader2, Save, Trash2 } from 'lucide-react';
import { LeadContextAvatar } from '@/components/messaging/LeadContextAvatar';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { fetchLeadContextByLeadId, resolveContact, type LeadContextByLead, type LeadTimelineEvent } from '@/lib/api/messaging';
import { updateLead } from '@/lib/api/pipeline';
import { apiClient } from '@/lib/api/client';
import { fetchContactNotes, fetchContactReminders, deleteNote, updateReminder, deleteReminder, type Note, type Reminder } from '@/lib/api/crm';
import { clsx } from 'clsx';

function formatLeadPanelDate(iso: string): string {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return '—';
  const d = new Date(iso);
  const day = d.getDate();
  const month = d.toLocaleString('en-GB', { month: 'short' });
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

/** Calendar day in UTC — aligns with Postgres `created_at` ordering for activity log. */
function formatLeadPanelDateUtc(iso: string): string {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return '—';
  const d = new Date(iso);
  const day = d.getUTCDate();
  const month = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

function timelineEventLabel(ev: LeadTimelineEvent, t: TFunction): string {
  if (ev.type === 'lead_created') return t('messaging.timelineLeadCreated', 'Lead created');
  if (ev.type === 'stage_changed') {
    const name = ev.stage_name ?? ev.to_stage_name ?? '—';
    return t('messaging.timelineStageChanged', { name });
  }
  if (ev.type === 'deal_created') return t('messaging.timelineDealCreated', 'Deal created');
  if (ev.type === 'campaign_reply_received') return t('messaging.timelineCampaignReplyReceived', 'Campaign reply received');
  return t('messaging.timelineEventGeneric', { type: ev.type });
}

interface TeamMember {
  id: string;
  user_id?: string;
  email: string;
  role: string;
}

interface LeadCardModalProps {
  leadId: string | null;
  open: boolean;
  onClose: () => void;
  onLeadUpdated?: () => void;
}

export function LeadCardModal({ leadId, open, onClose, onLeadUpdated }: LeadCardModalProps) {
  const { t } = useTranslation();
  const [context, setContext] = useState<LeadContextByLead | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editStageId, setEditStageId] = useState('');
  const [editResponsibleId, setEditResponsibleId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');

  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Resolved bd_account_id + channel_id for avatar when lead has no conversation */
  const [avatarResolution, setAvatarResolution] = useState<{ bd_account_id: string; channel_id: string } | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);

  useEffect(() => {
    if (!open || !leadId) {
      setContext(null);
      setError(null);
      setSaveError(null);
      setAvatarResolution(null);
      setNotes([]);
      setReminders([]);
      return;
    }
    setLoading(true);
    setError(null);
    setSaveError(null);
    setAvatarResolution(null);

    Promise.all([
      fetchLeadContextByLeadId(leadId),
      apiClient.get<{ id?: string; user_id?: string; email?: string; role?: string }[]>('/api/team/members').then((r) => r.data).catch(() => []),
    ])
      .then(([ctx, members]) => {
        setContext(ctx);
        setEditStageId(ctx?.stage?.id ?? '');
        setEditResponsibleId(ctx?.responsible_id ?? null);
        setEditAmount(ctx?.revenue_amount != null ? String(ctx.revenue_amount) : '');
        const normalized = Array.isArray(members)
          ? members.map((m) => ({ ...m, id: m.id ?? m.user_id })).filter((m): m is TeamMember => typeof m.id === 'string')
          : [];
        setTeamMembers(normalized);
        if (ctx?.contact_id && ctx?.contact_telegram_id && !ctx.bd_account_id) {
          resolveContact(ctx.contact_id)
            .then((r) => setAvatarResolution(r))
            .catch(() => {});
        }
      })
      .catch(() => setError(t('common.error', 'Error')))
      .finally(() => setLoading(false));
  }, [open, leadId, t]);

  useEffect(() => {
    if (!context?.contact_id) {
      setNotes([]);
      setReminders([]);
      return;
    }
    const cid = context.contact_id;
    fetchContactNotes(cid).then(setNotes).catch(() => setNotes([]));
    fetchContactReminders(cid).then(setReminders).catch(() => setReminders([]));
  }, [context?.contact_id]);

  const isDirty = useMemo(() => {
    if (!context) return false;
    if (editStageId !== context.stage.id) return true;
    const origResp = context.responsible_id ?? '';
    if ((editResponsibleId ?? '') !== origResp) return true;
    const origAmt = context.revenue_amount != null ? String(context.revenue_amount) : '';
    if (editAmount.trim() !== origAmt) return true;
    return false;
  }, [context, editStageId, editResponsibleId, editAmount]);

  const handleSave = useCallback(async () => {
    if (!leadId || !context || !isDirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = {};
      if (editStageId !== context.stage.id) body.stageId = editStageId;
      const origResp = context.responsible_id ?? '';
      if ((editResponsibleId ?? '') !== origResp) {
        body.responsibleId = editResponsibleId || null;
      }
      const origAmt = context.revenue_amount != null ? String(context.revenue_amount) : '';
      if (editAmount.trim() !== origAmt) {
        body.revenueAmount = editAmount.trim() === '' ? null : Number(editAmount.trim());
      }
      await updateLead(leadId, body as Parameters<typeof updateLead>[1]);
      const next = await fetchLeadContextByLeadId(leadId);
      setContext(next);
      setEditStageId(next.stage.id);
      setEditResponsibleId(next.responsible_id ?? null);
      setEditAmount(next.revenue_amount != null ? String(next.revenue_amount) : '');
      onLeadUpdated?.();
    } catch (e) {
      setSaveError((e as Error)?.message ?? t('common.error', 'Error'));
    } finally {
      setSaving(false);
    }
  }, [leadId, context, isDirty, editStageId, editResponsibleId, editAmount, t, onLeadUpdated]);

  const chatHref =
    context?.bd_account_id && context?.channel_id
      ? `/dashboard/messaging?bdAccountId=${encodeURIComponent(context.bd_account_id)}&open=${encodeURIComponent(context.channel_id)}`
      : null;

  const timelineChronological = useMemo(() => {
    if (!context?.timeline?.length) return [];
    return [...context.timeline].reverse();
  }, [context?.timeline]);

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={t('messaging.leadCardTitle', 'Lead card')}
      size="lg"
    >
      <div className="space-y-5">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}
        {error && <p className="text-sm text-destructive py-4">{error}</p>}
        {!loading && !error && context && (
          <>
            {/* Header */}
            <div className="flex flex-col items-center text-center pb-4 border-b border-border">
              <LeadContextAvatar
                contactName={context.contact_name}
                telegramId={context.channel_id ?? context.contact_telegram_id ?? avatarResolution?.channel_id}
                bdAccountId={context.bd_account_id ?? avatarResolution?.bd_account_id}
                className="w-14 h-14"
              />
              <h2 className="mt-3 font-heading text-xl font-semibold text-foreground truncate w-full px-2">
                {context.contact_name || '—'}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                {context.company_name || (context.contact_username ? `@${String(context.contact_username).replace(/^@/, '')}` : null) || '—'}
              </p>
              <span className="inline-block mt-2 text-[10px] font-medium px-2 py-0.5 rounded-md bg-primary/15 text-primary">
                {t('pipeline.leadCard', 'Lead')}
              </span>
            </div>

            {/* Editable fields — two columns on larger screens */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('pipeline.responsible', 'Responsible')}</label>
                <select
                  value={editResponsibleId ?? ''}
                  onChange={(e) => setEditResponsibleId(e.target.value || null)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  <option value="">— {t('pipeline.noResponsible', 'Not assigned')}</option>
                  {teamMembers.map((m) => (
                    <option key={m.id} value={m.id}>{m.email}</option>
                  ))}
                </select>
              </div>
              {context.became_lead_at && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">{t('pipeline.dateAdded', 'Date added')}</label>
                  <p className="text-sm text-foreground px-3 py-2 rounded-lg bg-muted/30 border border-transparent">{formatLeadPanelDate(context.became_lead_at)}</p>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('crm.pipelineStage', 'Pipeline / Stage')}</label>
                <p className="text-xs text-muted-foreground mb-1">{context.pipeline.name}</p>
                <select
                  value={editStageId}
                  onChange={(e) => setEditStageId(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  {(context.stages ?? []).map((st) => (
                    <option key={st.id} value={st.id}>{st.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('crm.amount', 'Amount')}</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={editAmount}
                  onChange={(e) => setEditAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                />
              </div>
              {(context.campaign != null || context.became_lead_at) && (
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-muted-foreground mb-1">{t('messaging.leadPanelCampaign', 'Campaign')}</label>
                  <p className="text-sm text-foreground px-3 py-2 rounded-lg bg-muted/30 border border-transparent">
                    {context.campaign != null ? context.campaign.name : '—'}
                  </p>
                </div>
              )}
            </div>

            {/* Notes */}
            <div className="border-t border-border pt-4 space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.notes', 'Notes')}</h4>
              {notes.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('crm.noNotes', 'No notes')}</p>
              ) : (
                <ul className="space-y-2">
                  {notes.map((note) => (
                    <li key={note.id} className="rounded-lg border border-border bg-muted/20 p-2 text-sm">
                      <p className="text-foreground whitespace-pre-wrap break-words">{note.content || '—'}</p>
                      <div className="flex items-center justify-between mt-1.5">
                        <span className="text-xs text-muted-foreground">{formatLeadPanelDate(note.created_at)}</span>
                        <button type="button" onClick={() => deleteNote(note.id).then(() => fetchContactNotes(context.contact_id!).then(setNotes))} className="text-muted-foreground hover:text-destructive text-xs flex items-center gap-1" aria-label={t('common.delete')}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Reminders */}
            <div className="border-t border-border pt-4 space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('crm.reminders', 'Reminders')}</h4>
              {reminders.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('crm.noReminders', 'No reminders')}</p>
              ) : (
                <ul className="space-y-2">
                  {reminders.map((rem) => (
                    <li key={rem.id} className={clsx('rounded-lg border p-2 text-sm', rem.done ? 'border-border bg-muted/10 opacity-75' : 'border-border bg-muted/20')}>
                      <p className="text-foreground font-medium">{rem.title || '—'}</p>
                      <div className="flex items-center justify-between mt-1.5 flex-wrap gap-1">
                        <span className="text-xs text-muted-foreground">{formatLeadPanelDate(rem.remind_at)}</span>
                        {rem.done ? (
                          <span className="text-xs text-emerald-600 dark:text-emerald-400">{t('crm.markDone', 'Done')}</span>
                        ) : (
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => updateReminder(rem.id, { done: true }).then(() => fetchContactReminders(context.contact_id!).then(setReminders))} className="text-xs text-primary hover:underline">{t('crm.markDone', 'Done')}</button>
                            <button type="button" onClick={() => deleteReminder(rem.id).then(() => fetchContactReminders(context.contact_id!).then(setReminders))} className="text-muted-foreground hover:text-destructive p-0.5" aria-label={t('common.delete')}><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Save */}
            {saveError && <p className="text-xs text-destructive">{saveError}</p>}
            {isDirty && (
              <Button type="button" onClick={handleSave} disabled={saving} className="w-full gap-2">
                <Save className="w-4 h-4" />
                {saving ? t('common.saving') : t('common.save')}
              </Button>
            )}

            {/* Shared chat link — only invite link works for private groups */}
            {context.shared_chat_created_at && (
              context.shared_chat_invite_link?.trim() ? (
                <a
                  href={context.shared_chat_invite_link.trim()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                >
                  <ExternalLink className="w-4 h-4" />
                  {t('messaging.openInTelegram', 'Open in Telegram')}
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">{t('messaging.sharedChatInviteLinkNotAvailable', 'Invite link not available; open the chat in Telegram')}</span>
              )
            )}

            {context.won_at && (
              <div className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                ✓ {t('messaging.dealWon', 'Deal won')}
                {context.revenue_amount != null && context.revenue_amount > 0 && ` — ${context.revenue_amount}`}
              </div>
            )}
            {context.lost_at && (
              <div className="text-sm text-muted-foreground">
                ✕ {t('messaging.dealLost', 'Deal lost')}
                {context.loss_reason && <div className="mt-1 text-xs opacity-90">{context.loss_reason}</div>}
              </div>
            )}

            {/* Timeline — oldest first (API returns newest first). */}
            <div className="border-t border-border pt-4 space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('messaging.timelineTitle', 'History')}</h4>
              {timelineChronological.length === 0 ? (
                <div className="text-xs text-muted-foreground">—</div>
              ) : (
                timelineChronological.map((ev) => (
                  <div key={ev.id} className="text-xs text-muted-foreground">
                    <span className="tabular-nums">{formatLeadPanelDateUtc(ev.created_at)}</span>
                    {' — '}
                    {timelineEventLabel(ev, t)}
                  </div>
                ))
              )}
            </div>

            {/* Footer actions */}
            <div className="flex gap-3 pt-2 border-t border-border">
              {chatHref && (
                <Link href={chatHref} className="flex-1" onClick={onClose}>
                  <Button type="button" className="w-full gap-2">
                    <MessageSquare className="w-4 h-4" />
                    {t('pipeline.goToChat', 'Go to chat')}
                  </Button>
                </Link>
              )}
              <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
                {t('pipeline.dealFormCancel', 'Close')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
