'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { Loader2, Save, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { patchBdAccount } from '@/lib/api/bd-accounts';
import { previewAutoResponderReply } from '@/lib/api/ai';
import { reportError } from '@/lib/error-reporter';
import type { BDAccount } from '@/lib/types/bd-account';

const IANA_TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Moscow',
  'Europe/Kyiv',
  'Asia/Dubai',
  'Asia/Almaty',
  'Asia/Tokyo',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
];

/** 0=Sun … 6=Sat — matches campaign-service helpers.dateInTz */
const WEEKDAY_OPTS: { v: number; key: string }[] = [
  { v: 0, key: 'bdAccounts.weekSun' },
  { v: 1, key: 'bdAccounts.weekMon' },
  { v: 2, key: 'bdAccounts.weekTue' },
  { v: 3, key: 'bdAccounts.weekWed' },
  { v: 4, key: 'bdAccounts.weekThu' },
  { v: 5, key: 'bdAccounts.weekFri' },
  { v: 6, key: 'bdAccounts.weekSat' },
];

const HISTORY_OPTS = [10, 25, 50, 100] as const;

interface Props {
  account: BDAccount;
  accountId: string;
  onPatched: (account: BDAccount) => void;
  /** Merged onto root wrapper (e.g. accordion: mt-0 pt-0 border-t-0). */
  className?: string;
}

export function BdAccountScheduleSettings({ account, accountId, onPatched, className }: Props) {
  const { t } = useTranslation();
  const [timezone, setTimezone] = useState(account.timezone ?? 'Europe/Moscow');
  const [start, setStart] = useState(account.working_hours_start ?? '09:00');
  const [end, setEnd] = useState(account.working_hours_end ?? '18:00');
  const [days, setDays] = useState<number[]>(account.working_days?.length ? [...account.working_days] : [1, 2, 3, 4, 5]);
  const [arOn, setArOn] = useState(Boolean(account.auto_responder_enabled));
  const [arPrompt, setArPrompt] = useState(account.auto_responder_system_prompt ?? '');
  const [arHistory, setArHistory] = useState<number>(account.auto_responder_history_count ?? 25);
  const [saving, setSaving] = useState(false);
  const [testIncoming, setTestIncoming] = useState('');
  const [testPreview, setTestPreview] = useState<string | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  useEffect(() => {
    setTimezone(account.timezone ?? 'Europe/Moscow');
    setStart(account.working_hours_start ?? '09:00');
    setEnd(account.working_hours_end ?? '18:00');
    setDays(account.working_days?.length ? [...account.working_days] : [1, 2, 3, 4, 5]);
    setArOn(Boolean(account.auto_responder_enabled));
    setArPrompt(account.auto_responder_system_prompt ?? '');
    setArHistory(account.auto_responder_history_count ?? 25);
  }, [
    account.id,
    account.timezone,
    account.working_hours_start,
    account.working_hours_end,
    account.working_days,
    account.auto_responder_enabled,
    account.auto_responder_system_prompt,
    account.auto_responder_history_count,
  ]);

  const toggleDay = (v: number) => {
    setDays((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v].sort((a, b) => a - b)));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const next = await patchBdAccount(accountId, {
        timezone: timezone.trim() || null,
        working_hours_start: start.trim() || null,
        working_hours_end: end.trim() || null,
        working_days: days.length ? days : null,
        auto_responder_enabled: arOn,
        auto_responder_system_prompt: arPrompt.trim() || null,
        auto_responder_history_count: arHistory,
      });
      onPatched(next);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={clsx(
        'mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 space-y-6',
        className
      )}
    >
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
          {t('bdAccounts.workingWindowTitle', { defaultValue: 'Рабочее окно' })}
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          {t('bdAccounts.workingWindowHint', {
            defaultValue: 'Кампании и автоответчик используют это окно, если у кампании не задано своё расписание.',
          })}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Timezone</label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm"
            >
              {IANA_TIMEZONES.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              {t('bdAccounts.workingStart', { defaultValue: 'Начало' })}
            </label>
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              {t('bdAccounts.workingEnd', { defaultValue: 'Конец' })}
            </label>
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm"
            />
          </div>
          <div className="sm:col-span-2 flex flex-wrap gap-2">
            {WEEKDAY_OPTS.map(({ v, key }) => (
              <label key={v} className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
                <input type="checkbox" checked={days.includes(v)} onChange={() => toggleDay(v)} className="rounded border-border" />
                {t(key)}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
          {t('bdAccounts.autoResponderTitle', { defaultValue: 'Автоответчик (вне рабочего окна)' })}
        </h3>
        <label className="flex items-center gap-2 text-sm mb-3">
          <input type="checkbox" checked={arOn} onChange={(e) => setArOn(e.target.checked)} className="rounded border-border" />
          {t('bdAccounts.autoResponderEnable', { defaultValue: 'Включить' })}
        </label>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
          {t('bdAccounts.autoResponderPrompt', { defaultValue: 'Системный промпт' })}
        </label>
        <textarea
          value={arPrompt}
          onChange={(e) => setArPrompt(e.target.value)}
          rows={4}
          disabled={!arOn}
          placeholder={t('bdAccounts.autoResponderPromptPh', { defaultValue: 'Стиль ответов в нерабочее время…' })}
          className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm resize-y mb-3 disabled:opacity-50"
        />
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
          {t('bdAccounts.autoResponderHistory', { defaultValue: 'Сообщений истории' })}
        </label>
        <select
          value={arHistory}
          onChange={(e) => setArHistory(Number(e.target.value))}
          disabled={!arOn}
          className="w-full max-w-xs px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm disabled:opacity-50"
        >
          {HISTORY_OPTS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground mt-3 mb-1">
          {t('bdAccounts.autoResponderTestHint', { defaultValue: 'Проверка ответа AI (не отправляется в Telegram)' })}
        </p>
        <textarea
          value={testIncoming}
          onChange={(e) => setTestIncoming(e.target.value)}
          disabled={!arOn}
          rows={2}
          placeholder={t('bdAccounts.autoResponderTestPlaceholder', { defaultValue: 'Входящее сообщение для теста…' })}
          className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm resize-y mb-2 disabled:opacity-50"
        />
        <div className="flex flex-wrap gap-2 items-center mb-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!arOn || testLoading || !arPrompt.trim() || !testIncoming.trim()}
            onClick={async () => {
              setTestLoading(true);
              setTestPreview(null);
              try {
                const r = await previewAutoResponderReply({
                  systemPrompt: arPrompt.trim(),
                  conversationHistory: [],
                  incomingMessage: testIncoming.trim(),
                });
                setTestPreview(r.text || '');
              } catch (e) {
                reportError(e, { component: 'BdAccountScheduleSettings', action: 'autoResponderTest' });
              } finally {
                setTestLoading(false);
              }
            }}
          >
            {testLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Sparkles className="w-4 h-4 mr-1" />}
            {t('bdAccounts.autoResponderTest', { defaultValue: 'Тест ответа' })}
          </Button>
        </div>
        {testPreview != null && (
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm whitespace-pre-wrap">{testPreview}</div>
        )}
      </div>

      <Button size="sm" onClick={handleSave} disabled={saving}>
        {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Save className="w-4 h-4 mr-1" />}
        {t('common.save', { defaultValue: 'Сохранить' })}
      </Button>
    </div>
  );
}
