'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { createContactReminder } from '@/lib/api/crm';
import { Loader2, Calendar, Clock } from 'lucide-react';

export interface AddReminderModalProps {
  open: boolean;
  onClose: () => void;
  contactId: string;
  onSuccess?: () => void;
}

function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}:${min}`;
}

function fromDatetimeLocal(value: string): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function getDefaultDatetimeLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 30);
  d.setSeconds(0, 0);
  return toDatetimeLocal(d.toISOString());
}

export function AddReminderModal({ open, onClose, contactId, onSuccess }: AddReminderModalProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [datetimeLocal, setDatetimeLocal] = useState(getDefaultDatetimeLocal);
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (open) setDatetimeLocal(getDefaultDatetimeLocal());
  }, [open]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  const wrapSelection = useCallback((before: string, after: string) => {
    const ta = descRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const text = description;
    const selected = text.slice(start, end);
    const newText = text.slice(0, start) + before + selected + after + text.slice(end);
    setDescription(newText);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(start + before.length, end + before.length);
    }, 0);
  }, [description]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const remindAt = fromDatetimeLocal(datetimeLocal);
    if (!remindAt || saving) return;
    setError(null);
    setSaving(true);
    try {
      const noteTitle = [title.trim(), description.trim()].filter(Boolean).join(' — ') || undefined;
      await createContactReminder(contactId, { remind_at: remindAt, title: noteTitle ?? undefined });
      setTitle('');
      setDatetimeLocal(getDefaultDatetimeLocal());
      setDescription('');
      onSuccess?.();
      onClose();
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (!saving) {
      setTitle('');
      setDatetimeLocal(getDefaultDatetimeLocal());
      setDescription('');
      setError(null);
      onClose();
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={handleClose}
      title={t('messaging.reminderModalTitle', 'НАПОМИНАНИЕ')}
      size="md"
    >
      <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
        <div>
          <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
            {t('messaging.reminderModalTitleLabel', 'Напоминание')}
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('messaging.reminderTitlePlaceholder', 'Текст напоминания')}
            className="w-full px-3 py-2.5 rounded-xl border border-border bg-background text-foreground text-sm"
            disabled={saving}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
              {t('messaging.reminderDate', 'Дата')}
            </label>
            <div className="relative">
              <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <input
                type="date"
                value={datetimeLocal.slice(0, 10)}
                onChange={(e) => setDatetimeLocal((prev) => (prev ? e.target.value + prev.slice(10) : e.target.value + 'T12:00'))}
                className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border bg-background text-foreground text-sm"
                disabled={saving}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
              {t('messaging.reminderTime', 'Время')}
            </label>
            <div className="relative">
              <Clock className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <input
                type="time"
                value={datetimeLocal.slice(11, 16)}
                onChange={(e) => setDatetimeLocal((prev) => (prev ? prev.slice(0, 11) + e.target.value + (prev.slice(16) || '') : ''))}
                className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border bg-background text-foreground text-sm"
                disabled={saving}
              />
            </div>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
            {t('messaging.reminderDescription', 'Описание')}
          </label>
          <textarea
            ref={descRef}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('messaging.reminderDescriptionPlaceholder', 'Дополнительно...')}
            className="w-full min-h-[80px] px-3 py-2.5 rounded-xl border border-border bg-background text-foreground text-sm resize-y"
            disabled={saving}
          />
          <div className="flex items-center gap-2 mt-1.5">
            <button
              type="button"
              onClick={() => wrapSelection('**', '**')}
              className="px-2.5 py-1 rounded border border-border bg-muted/30 text-xs font-bold text-foreground hover:bg-muted/50"
            >
              B
            </button>
            <button
              type="button"
              onClick={() => wrapSelection('_', '_')}
              className="px-2.5 py-1 rounded border border-border bg-muted/30 text-xs italic text-foreground hover:bg-muted/50"
            >
              I
            </button>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={!datetimeLocal || saving}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : t('messaging.createReminder', 'Создать напоминание')}
        </Button>
      </form>
    </Modal>
  );
}
