'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import {
  createSharedChat,
  fetchLeadContext,
  fetchLeadContextByLeadId,
  pollLeadContextUntilSharedChatReady,
} from '@/lib/api/messaging';
import { reportError } from '@/lib/error-reporter';
import type { LeadContext } from '@/app/dashboard/messaging/types';

interface SharedChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  leadContext: LeadContext | null;
  /** Selected BD account in UI (used when conversation has no bd_account_id). */
  selectedAccountId?: string | null;
  /** Display name of the selected BD account (shown in participants for clarity). */
  selectedAccountName?: string | null;
  onSuccess: (updatedContext: LeadContext) => void;
}

export function SharedChatModal({ isOpen, onClose, leadContext, selectedAccountId, selectedAccountName, onSuccess }: SharedChatModalProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [extraUsernames, setExtraUsernames] = useState<string[]>([]);
  const [newUsername, setNewUsername] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen && leadContext) {
      const template = leadContext.shared_chat_settings?.titleTemplate ?? 'Чат: {{contact_name}}';
      setTitle(template.replace(/\{\{\s*contact_name\s*\}\}/gi, (leadContext.contact_name || 'Контакт').trim()).trim());
      setExtraUsernames(leadContext.shared_chat_settings?.extraUsernames ?? []);
      setNewUsername('');
    }
  }, [isOpen, leadContext]);

  const addUsername = () => {
    const v = newUsername.trim().replace(/^@/, '');
    if (v && !extraUsernames.includes(v)) {
      setExtraUsernames((prev) => [...prev, v]);
      setNewUsername('');
    }
  };

  const handleSubmit = async () => {
    if (!leadContext || !title.trim()) return;
    const convId = leadContext.conversation_id ?? null;
    const leadId = leadContext.lead_id ?? null;
    if (!convId && !leadId) {
      reportError(new Error('No conversation or lead to create shared chat for'), { component: 'SharedChatModal', action: 'createSharedChat' });
      return;
    }
    if (!convId && leadId && !selectedAccountId && !leadContext.bd_account_id) {
      reportError(new Error('Select a BD account to create shared chat for this lead'), { component: 'SharedChatModal', action: 'createSharedChat' });
      return;
    }
    setSubmitting(true);
    try {
      const result = await createSharedChat({
        ...(convId ? { conversation_id: convId } : { lead_id: leadId, bd_account_id: selectedAccountId ?? leadContext.bd_account_id ?? undefined }),
        title: title.trim() || undefined,
        participant_usernames: extraUsernames,
        bd_account_id: selectedAccountId ?? leadContext.bd_account_id ?? undefined,
      });
      const cid = result.conversation_id;
      const updatedContext = cid
        ? await pollLeadContextUntilSharedChatReady(cid)
        : leadId
          ? await fetchLeadContextByLeadId(leadId)
          : null;
      if (updatedContext) onSuccess(updatedContext as LeadContext);
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        const convId2 = leadContext.conversation_id ?? (e as { response?: { data?: { conversation_id?: string } } })?.response?.data?.conversation_id;
        const updatedContext = convId2 ? await fetchLeadContext(convId2) : (leadId ? await fetchLeadContextByLeadId(leadId) : null);
        if (updatedContext) onSuccess(updatedContext as LeadContext);
      } else {
        reportError(e, { component: 'SharedChatModal', action: 'createSharedChat' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !submitting && onClose()}
      title={t('messaging.createSharedChatModalTitle', 'Создать общий чат в Telegram')}
      size="md"
    >
      <div className="px-6 py-4 space-y-5">
        <p className="text-sm text-muted-foreground">
          {t('messaging.createSharedChatModalDesc', 'Будет создана группа в Telegram.')}
        </p>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            {t('messaging.sharedChatTitle', 'Название чата')}
          </label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('messaging.sharedChatTitlePlaceholder', 'Чат: Имя контакта')}
            className="w-full"
            maxLength={255}
          />
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            {t('messaging.sharedChatParticipants', 'Участники')}
          </label>
          <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
            {selectedAccountName && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground shrink-0">
                  {t('messaging.sharedChatBdParticipant', 'BD')}:
                </span>
                <span className="font-medium text-foreground truncate">
                  {selectedAccountName}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground shrink-0">
                {t('messaging.sharedChatLeadParticipant', 'Лид')}:
              </span>
              <span className="font-medium text-foreground truncate">
                {leadContext?.contact_username
                  ? `@${leadContext.contact_username}`
                  : leadContext?.contact_name || '—'}
              </span>
            </div>

            {extraUsernames.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1 border-t border-border">
                {extraUsernames.map((u, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 rounded-md bg-background border border-border px-2.5 py-1 text-sm">
                    @{u}
                    <button
                      type="button"
                      onClick={() => setExtraUsernames((prev) => prev.filter((_, j) => j !== i))}
                      className="text-muted-foreground hover:text-destructive rounded p-0.5"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <input
                type="text"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder={t('messaging.sharedChatAddUsername', 'Добавить @username')}
                className="flex-1 min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addUsername(); } }}
              />
              <Button type="button" variant="secondary" size="sm" onClick={addUsername}>
                {t('common.add', 'Добавить')}
              </Button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t('global.cancel', 'Отмена')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !title.trim()}>
            {submitting && <Loader2 className="w-4 h-4 animate-spin shrink-0 mr-2" />}
            {submitting
              ? t('messaging.creating', 'Создание…')
              : t('messaging.createSharedChat', 'Создать общий чат')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
