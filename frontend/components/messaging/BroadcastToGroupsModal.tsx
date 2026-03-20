'use client';

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { postBdAccountSendBulk } from '@/lib/api/bd-accounts';
import { fetchGroupSources, type GroupSource } from '@/lib/api/campaigns';

interface BroadcastToGroupsModalProps {
  accountId: string;
  accountName: string;
  onClose: () => void;
}

export function BroadcastToGroupsModal({ accountId, accountName, onClose }: BroadcastToGroupsModalProps) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<GroupSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent: number; failed: { channelId: string; error: string }[] } | null>(null);

  useEffect(() => {
    fetchGroupSources()
      .then((list) => setGroups(list.filter((g) => g.bd_account_id === accountId)))
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  const toggle = (telegramChatId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(telegramChatId)) next.delete(telegramChatId);
      else next.add(telegramChatId);
      return next;
    });
  };

  const handleSend = async () => {
    if (selectedIds.size === 0 || !text.trim()) return;
    setSending(true);
    setResult(null);
    try {
      const res = await postBdAccountSendBulk(accountId, {
        channelIds: Array.from(selectedIds),
        text: text.trim(),
      });
      setResult(res);
    } catch (err: unknown) {
      const resp = (err as { response?: { data?: { message?: string; error?: string } } })?.response?.data;
      setResult({ sent: 0, failed: [{ channelId: '', error: resp?.message || resp?.error || String(err) }] });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-card rounded-xl shadow-xl border border-border max-w-lg w-full mx-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-border font-semibold text-foreground">
          {t('messaging.broadcastToGroups', 'Рассылка в группы')} — {accountName}
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : groups.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">{t('messaging.noGroupsSynced', 'Нет групповых чатов')}</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t('messaging.broadcastSelectGroups', 'Выберите группы и введите сообщение')}</p>
              <div className="max-h-48 overflow-y-auto border border-border rounded-lg divide-y divide-border">
                {groups.map((g) => (
                  <label key={g.telegram_chat_id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/30 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(g.telegram_chat_id)}
                      onChange={() => toggle(g.telegram_chat_id)}
                      className="rounded border-border"
                    />
                    <span className="text-sm text-foreground truncate flex-1">{g.title || g.telegram_chat_id}</span>
                  </label>
                ))}
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">{t('messaging.message', 'Сообщение')}</label>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={t('messaging.typeMessage', 'Введите текст...')}
                  rows={4}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-hidden focus:ring-2 focus:ring-ring resize-none"
                />
              </div>
              {result && (
                <div className="p-3 rounded-lg bg-muted/50 text-sm text-foreground">
                  {t('messaging.sent', 'Отправлено')}: {result.sent}
                  {result.failed.length > 0 && (
                    <span className="text-destructive ml-2">{t('messaging.failed', 'Ошибки')}: {result.failed.length}</span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="p-4 border-t border-border flex gap-2 justify-end">
          <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
          <Button
            disabled={loading || selectedIds.size === 0 || !text.trim() || sending}
            onClick={handleSend}
          >
            {sending ? t('common.sending', 'Отправка...') : t('messaging.sendToGroups', 'Отправить в выбранные')}
          </Button>
        </div>
      </div>
    </div>
  );
}
