'use client';

import Button from '@/components/ui/Button';
import type { ParseResult } from '@/lib/api/discovery';

interface ParseResultSummaryProps {
  result: ParseResult;
  onExportCsv?: () => void;
  onAddToCampaign?: () => void;
  onRunAgain?: () => void;
}

export default function ParseResultSummary({
  result,
  onExportCsv,
  onAddToCampaign,
  onRunAgain,
}: ParseResultSummaryProps) {
  const parsed = result.parsed ?? 0;

  return (
    <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow border border-gray-200 dark:border-gray-700 space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Парсинг завершён</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{result.name}</p>
      </div>
      <div className="flex items-center gap-4 p-4 rounded-lg bg-gray-50 dark:bg-gray-900">
        <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">{parsed}</span>
        <span className="text-gray-600 dark:text-gray-400">участников собрано</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {onExportCsv && (
          <Button variant="outline" size="sm" onClick={onExportCsv}>
            Скачать CSV
          </Button>
        )}
        {onAddToCampaign && (
          <Button variant="outline" size="sm" onClick={onAddToCampaign}>
            Добавить в рассылку
          </Button>
        )}
        {onRunAgain && (
          <Button size="sm" onClick={onRunAgain}>
            Запустить ещё раз
          </Button>
        )}
      </div>
    </div>
  );
}
