'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  FileText,
  MessageSquare,
  Send,
  Bot,
  Zap,
  MessageCircle,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { apiClient } from '@/lib/api/client';

export interface AnalysisPayload {
  chat_meta?: Record<string, unknown>;
  project_summary?: string;
  fundraising_status?: string;
  stage?: string;
  last_activity?: string;
  risk_zone?: string;
  recommendations?: string[];
  draft_message?: string;
}

interface AIAssistantTabContentProps {
  conversationId: string | null;
  bdAccountId: string | null;
  onInsertDraft?: (text: string) => void;
  isLead: boolean;
}

type CommandId = 'summary' | 'draft' | 'auto_reply' | 'ideas' | 'tone';

const COMMANDS: { id: CommandId; icon: typeof FileText; titleKey: string; subtitleKey: string }[] = [
  { id: 'summary', icon: FileText, titleKey: 'messaging.aiCmdSummary', subtitleKey: 'messaging.aiCmdSummarySub' },
  { id: 'draft', icon: Send, titleKey: 'messaging.aiCmdDraft', subtitleKey: 'messaging.aiCmdDraftSub' },
  { id: 'auto_reply', icon: Bot, titleKey: 'messaging.aiCmdAutoReply', subtitleKey: 'messaging.aiCmdAutoReplySub' },
  { id: 'ideas', icon: MessageCircle, titleKey: 'messaging.aiCmdIdeas', subtitleKey: 'messaging.aiCmdIdeasSub' },
  { id: 'tone', icon: Zap, titleKey: 'messaging.aiCmdTone', subtitleKey: 'messaging.aiCmdToneSub' },
];

export function AIAssistantTabContent({
  conversationId,
  bdAccountId,
  onInsertDraft,
  isLead,
}: AIAssistantTabContentProps) {
  const { t } = useTranslation();
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [lastAnalysis, setLastAnalysis] = useState<AnalysisPayload | null>(null);
  const [lastSummary, setLastSummary] = useState<string | null>(null);
  const [summaryScope, setSummaryScope] = useState<'last_7_days' | 'full' | 'since_sync'>('last_7_days');
  const [assistantQuery, setAssistantQuery] = useState('');

  const canRequest = Boolean(conversationId && bdAccountId);

  const handleGenerateAnalysis = async () => {
    if (!canRequest || !isLead) return;
    setAnalysisError(null);
    setAnalysisLoading(true);
    try {
      const { data } = await apiClient.post<AnalysisPayload>(
        `/api/messaging/conversations/${conversationId}/ai/analysis`
      );
      setLastAnalysis(data ?? null);
    } catch (e: unknown) {
      setLastAnalysis(null);
      const err = e as { response?: { data?: { error?: string; message?: string }; status?: number } };
      const msg = err?.response?.data?.message || err?.response?.data?.error;
      setAnalysisError(msg || (e instanceof Error ? e.message : 'Failed to generate analysis'));
    } finally {
      setAnalysisLoading(false);
    }
  };

  const handleSummarize = async () => {
    if (!canRequest) return;
    setSummaryError(null);
    setSummaryLoading(true);
    try {
      const { data } = await apiClient.post<{ summary?: string }>(
        `/api/messaging/conversations/${conversationId}/ai/summary`,
        { scope: summaryScope }
      );
      setLastSummary(data?.summary ?? '');
    } catch (e: unknown) {
      setLastSummary(null);
      const err = e as { response?: { data?: { error?: string; message?: string } } };
      const msg = err?.response?.data?.message || err?.response?.data?.error;
      setSummaryError(msg || (e instanceof Error ? e.message : 'Failed to summarize'));
    } finally {
      setSummaryLoading(false);
    }
  };

  const handleCommandClick = (id: CommandId) => {
    if (id === 'summary') handleSummarize();
    else if (id === 'draft' && isLead) handleGenerateAnalysis();
  };

  const handleInsertDraft = () => {
    const draft = lastAnalysis?.draft_message;
    if (draft && onInsertDraft) onInsertDraft(draft);
  };

  const summaryLoadingState = summaryLoading;
  const analysisLoadingState = analysisLoading;
  const anyError = summaryError || analysisError;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Команды для текущего чата */}
      <div className="shrink-0 p-3 space-y-3 border-b border-border">
        <p className="text-xs text-muted-foreground">
          {t('messaging.aiCommandsLabel', 'Команды для текущего чата')}
        </p>
        <ul className="space-y-2">
          {COMMANDS.map(({ id, icon: Icon, titleKey, subtitleKey }) => {
            const isSummary = id === 'summary';
            const isDraft = id === 'draft';
            const isAvailable = isSummary || (isDraft && isLead);
            const disabled =
              !canRequest ||
              (isDraft && !isLead) ||
              (isSummary && summaryLoadingState) ||
              (isDraft && analysisLoadingState);
            const loading = (isSummary && summaryLoadingState) || (isDraft && analysisLoadingState);
            const comingSoon = !isAvailable;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => !comingSoon && handleCommandClick(id)}
                  disabled={disabled || comingSoon}
                  title={comingSoon ? t('common.comingSoon', 'Скоро') : undefined}
                  className="w-full flex items-center gap-3 p-3 rounded-xl border border-border bg-muted/20 hover:bg-muted/40 text-left transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                    {loading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Icon className="w-4 h-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">
                      {t(titleKey)}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {t(subtitleKey)}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
        {anyError && (
          <p className="text-xs text-destructive">
            {anyError}
          </p>
        )}
      </div>

      {/* Результаты саммари / анализа */}
      {(lastSummary || lastAnalysis) && (
        <div className="shrink-0 p-3 space-y-2 border-b border-border max-h-48 overflow-y-auto">
          {lastSummary && (
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs">
              <span className="font-medium text-muted-foreground">{t('messaging.summaryResult', 'Саммари')}:</span>
              <p className="mt-1 text-foreground whitespace-pre-wrap">{lastSummary}</p>
            </div>
          )}
          {lastAnalysis && (
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs space-y-2">
              {lastAnalysis.project_summary && (
                <div>
                  <span className="font-medium text-muted-foreground">Summary:</span>
                  <p className="mt-0.5 text-foreground whitespace-pre-wrap">{lastAnalysis.project_summary}</p>
                </div>
              )}
              {lastAnalysis.draft_message && (
                <div className="pt-2 border-t border-border">
                  <p className="font-medium text-muted-foreground mb-1">Draft (AI)</p>
                  <p className="text-foreground whitespace-pre-wrap mb-2">{lastAnalysis.draft_message}</p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full gap-2"
                    onClick={handleInsertDraft}
                  >
                    <MessageSquare className="w-3 h-3" />
                    {t('messaging.insertIntoMessage', 'Вставить в сообщение')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Чат с помощником (заглушка) */}
      <div className="flex-1 min-h-0 flex flex-col p-3">
        <p className="text-xs text-muted-foreground mb-2">
          {t('messaging.aiChatLabel', 'Чат с помощником')}
        </p>
        <div className="flex-1 min-h-[120px] rounded-xl border border-border bg-muted/10 flex items-center justify-center p-4 text-center">
          <p className="text-xs text-muted-foreground">
            {t('messaging.aiChatPlaceholder', 'Здесь будет диалог в стиле ChatGPT/Claude — ввод запроса и ответы ИИ. Пока без бэкенда.')}
          </p>
        </div>
        <div className="mt-2">
          <input
            type="text"
            value={assistantQuery}
            onChange={(e) => setAssistantQuery(e.target.value)}
            placeholder={t('messaging.aiChatInputPlaceholder', 'Спросить помощника...')}
            className="w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            disabled
          />
        </div>
      </div>

      {!canRequest && (
        <p className="shrink-0 px-3 pb-2 text-xs text-muted-foreground">
          {t('messaging.aiSelectChatHint', 'Выберите чат для доступа к AI-инструментам.')}
        </p>
      )}
    </div>
  );
}
