'use client';

import Button from '@/components/ui/Button';
import type { ResolvedSource } from '@/lib/api/discovery';
import type { ParseSettings } from '@/lib/api/discovery';

interface ParseSettingsFormProps {
  sources: ResolvedSource[];
  accountOptions: { id: string; label: string }[];
  selectedAccountIds: string[];
  onAccountIdsChange: (ids: string[]) => void;
  depth: 'fast' | 'standard' | 'deep';
  onDepthChange: (d: 'fast' | 'standard' | 'deep') => void;
  excludeAdmins: boolean;
  onExcludeAdminsChange: (v: boolean) => void;
  listName: string;
  onListNameChange: (v: string) => void;
  onStart: () => void;
  starting?: boolean;
  disabled?: boolean;
}

export default function ParseSettingsForm({
  sources,
  accountOptions,
  selectedAccountIds,
  onAccountIdsChange,
  depth,
  onDepthChange,
  excludeAdmins,
  onExcludeAdminsChange,
  listName,
  onListNameChange,
  onStart,
  starting,
  disabled,
}: ParseSettingsFormProps) {
  const validSources = sources.filter((s) => !s.error && s.chatId);

  const toggleAccount = (id: string) => {
    if (selectedAccountIds.includes(id)) {
      onAccountIdsChange(selectedAccountIds.filter((x) => x !== id));
    } else {
      onAccountIdsChange([...selectedAccountIds, id].slice(-10));
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium mb-2">Глубина парсинга</label>
        <div className="flex flex-wrap gap-3">
          {(['fast', 'standard', 'deep'] as const).map((d) => (
            <label key={d} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="depth"
                checked={depth === d}
                onChange={() => onDepthChange(d)}
                disabled={disabled}
                className="w-4 h-4"
              />
              <span className="text-sm">
                {d === 'fast' && 'Быстро (~500 уч., 3 дня)'}
                {d === 'standard' && 'Стандарт (~2000 уч., 7 дней)'}
                {d === 'deep' && 'Глубокий (~5000 уч., 30 дней)'}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Аккаунты для парсинга</label>
        <p className="text-xs text-gray-500 mb-2">Рекомендуем 2–3 аккаунта для больших групп</p>
        <div className="flex flex-wrap gap-2">
          {accountOptions.map((a) => (
            <label key={a.id} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedAccountIds.includes(a.id)}
                onChange={() => toggleAccount(a.id)}
                disabled={disabled}
                className="w-4 h-4 rounded text-blue-600"
              />
              <span className="text-sm">{a.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={excludeAdmins}
            onChange={(e) => onExcludeAdminsChange(e.target.checked)}
            disabled={disabled}
            className="w-4 h-4 rounded text-blue-600"
          />
          <span className="text-sm">Исключить администраторов</span>
        </label>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Название списка для сохранения</label>
        <input
          type="text"
          value={listName}
          onChange={(e) => onListNameChange(e.target.value)}
          placeholder="Например: Крипто-аудитория"
          className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-sm"
          disabled={disabled}
        />
      </div>

      <Button
        onClick={onStart}
        disabled={disabled || starting || validSources.length === 0 || selectedAccountIds.length === 0}
        className="w-full justify-center bg-green-600 hover:bg-green-700 text-white"
      >
        {starting ? 'Запуск...' : 'Запустить парсинг'}
      </Button>
    </div>
  );
}
