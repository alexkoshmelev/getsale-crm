'use client';

import React, { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { createContactNote } from '@/lib/api/crm';
import { Loader2 } from 'lucide-react';

export interface AddNoteModalProps {
  open: boolean;
  onClose: () => void;
  contactId: string;
  onSuccess?: () => void;
}

export function AddNoteModal({ open, onClose, contactId, onSuccess }: AddNoteModalProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const wrapSelection = useCallback((before: string, after: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const text = content;
    const selected = text.slice(start, end);
    const newText = text.slice(0, start) + before + selected + after + text.slice(end);
    setContent(newText);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(start + before.length, end + before.length);
    }, 0);
  }, [content]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || saving) return;
    setError(null);
    setSaving(true);
    try {
      await createContactNote(contactId, trimmed);
      setContent('');
      onSuccess?.();
      onClose();
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? t('common.error', 'Ошибка'));
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (!saving) {
      setContent('');
      setError(null);
      onClose();
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={handleClose}
      title={t('messaging.noteModalTitle', 'ЗАМЕТКА')}
      size="md"
    >
      <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('messaging.notePlaceholder', 'Текст заметки...')}
          className="w-full min-h-[120px] px-3 py-2.5 rounded-xl border border-border bg-background text-foreground text-sm resize-y"
          disabled={saving}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => wrapSelection('**', '**')}
            className="px-3 py-1.5 rounded border border-border bg-muted/30 text-sm font-bold text-foreground hover:bg-muted/50"
            title={t('messaging.formatBold', 'Жирный')}
          >
            B
          </button>
          <button
            type="button"
            onClick={() => wrapSelection('_', '_')}
            className="px-3 py-1.5 rounded border border-border bg-muted/30 text-sm italic text-foreground hover:bg-muted/50"
            title={t('messaging.formatItalic', 'Курсив')}
          >
            I
          </button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={!content.trim() || saving}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : t('messaging.createNote', 'Создать заметку')}
        </Button>
      </form>
    </Modal>
  );
}
