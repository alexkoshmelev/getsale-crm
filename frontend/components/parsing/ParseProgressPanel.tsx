'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Pause, Square } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useEventsStream } from '@/lib/contexts/events-stream-context';
import { parsePause, parseStop } from '@/lib/api/discovery';

interface ParseProgressPanelProps {
  taskId: string;
  onStopped?: () => void;
}

interface ProgressEvent {
  taskId?: string;
  stage?: string;
  stageLabel?: string;
  percent?: number;
  found?: number;
  estimated?: number;
  progress?: number;
  total?: number;
  status?: string;
  error?: string;
}

export default function ParseProgressPanel({ taskId, onStopped }: ParseProgressPanelProps) {
  const { t } = useTranslation();
  const [event, setEvent] = useState<ProgressEvent | null>(null);
  const [pausing, setPausing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const { subscribe } = useEventsStream();

  useEffect(() => {
    const unsub = subscribe('parse_progress', (data: Record<string, unknown>) => {
      if ((data.taskId as string) !== taskId) return;
      setEvent(data as ProgressEvent);
      const status = data.status as string;
      if (status === 'completed' || status === 'stopped' || status === 'failed') {
        onStopped?.();
      }
    });
    return unsub;
  }, [taskId, onStopped, subscribe]);

  const handlePause = async () => {
    setPausing(true);
    try {
      await parsePause(taskId);
      onStopped?.();
    } finally {
      setPausing(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      await parseStop(taskId);
      onStopped?.();
    } finally {
      setStopping(false);
    }
  };

  const percent = event?.percent ?? 0;
  const found = event?.found ?? 0;
  const total = event?.total ?? 0;
  const status = event?.status ?? 'running';

  return (
    <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow border border-gray-200 dark:border-gray-700 space-y-4">
      <div className="flex items-center gap-2 text-gray-900 dark:text-gray-100 font-medium">
        {status === 'running' || status === 'paused' ? (
          <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
        ) : null}
        {status === 'failed' ? t('parsing.progressCompletedError') : status === 'completed' || status === 'stopped' ? t('parsing.progressCompleted') : t('parsing.progressRunning')}
      </div>
      <div className="text-sm text-gray-600 dark:text-gray-400">
        {event?.stageLabel ?? t('parsing.progressLoading')}
      </div>
      {status === 'failed' && event?.error && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
          {t('parsing.progressErrorLabel')}: {event.error}
        </div>
      )}
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
        <div
          className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      <div className="flex justify-between text-sm text-gray-500 dark:text-gray-400">
        <span>{t('parsing.participantsCollected')}: {found}{total > 0 ? ` / ${total}` : ''}</span>
        <span>{percent}%</span>
      </div>
      {(status === 'running' || status === 'paused') && (
        <div className="flex gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={handlePause} disabled={pausing || status !== 'running'}>
            <Pause className="w-4 h-4" /> {t('parsing.pauseButton')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleStop} disabled={stopping}>
            <Square className="w-4 h-4" /> {t('parsing.stopButton')}
          </Button>
        </div>
      )}
    </div>
  );
}
