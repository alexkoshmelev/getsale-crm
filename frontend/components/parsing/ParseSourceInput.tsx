'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '@/components/ui/Button';
import { Loader2 } from 'lucide-react';

interface ParseSourceInputProps {
  onResolve: (sources: string[], bdAccountId: string) => Promise<void>;
  bdAccountId: string;
  onBdAccountIdChange: (id: string) => void;
  accountOptions: { id: string; label: string }[];
  disabled?: boolean;
}

export default function ParseSourceInput({
  onResolve,
  bdAccountId,
  onBdAccountIdChange,
  accountOptions,
  disabled,
}: ParseSourceInputProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const lines = text
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      setError(t('parsing.errorEnterLink'));
      return;
    }
    if (!bdAccountId) {
      setError(t('parsing.errorSelectAccount'));
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await onResolve(lines, bdAccountId);
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: string }).message) : t('parsing.errorResolve');
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">
          {t('parsing.sourceLabel')}
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('parsing.sourcePlaceholder')}
          className="w-full h-32 p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-sm"
          disabled={disabled}
        />
        <p className="text-xs text-gray-500 mt-1">
          {t('parsing.sourceHint')}
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">{t('parsing.accountForResolve')}</label>
        <select
          value={bdAccountId}
          onChange={(e) => { setError(null); onBdAccountIdChange(e.target.value); }}
          className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800"
          disabled={disabled}
        >
          <option value="">{t('parsing.selectAccount')}</option>
          {accountOptions.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
      </div>
      {error && (
        <div className="p-2 rounded-md bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}
      <Button onClick={handleSubmit} disabled={loading || disabled} className="w-full justify-center">
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('parsing.checkAndContinue')}
      </Button>
    </div>
  );
}
