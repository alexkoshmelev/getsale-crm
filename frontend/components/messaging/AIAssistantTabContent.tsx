'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  FileText,
  MessageSquare,
  Send,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { apiClient } from '@/lib/api/client';

const STORAGE_KEY_PREFIX = 'getsale_ai_chat_';

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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  type?: 'summary' | 'draft';
  createdAt?: string;
}

interface AIAssistantTabContentProps {
  conversationId: string | null;
  bdAccountId: string | null;
  onInsertDraft?: (text: string) => void;
  isLead: boolean;
}

const MESSAGE_LIMIT_OPTIONS = [10, 25, 50, 100] as const;

function loadStoredMessages(conversationId: string | null): ChatMessage[] {
  if (!conversationId || typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + conversationId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ChatMessage =>
        m && typeof m === 'object' && typeof m.id === 'string' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
    ).map((m) => ({ ...m, createdAt: typeof m.createdAt === 'string' ? m.createdAt : undefined }));
  } catch {
    return [];
  }
}

function saveMessages(conversationId: string | null, messages: ChatMessage[]) {
  if (!conversationId || typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + conversationId, JSON.stringify(messages));
  } catch { /* ignore */ }
}

export function AIAssistantTabContent({
  conversationId,
  bdAccountId,
  onInsertDraft,
  isLead,
}: AIAssistantTabContentProps) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageLimit, setMessageLimit] = useState<number>(25);
  const [assistantQuery, setAssistantQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const canRequest = Boolean(conversationId && bdAccountId);
  const loading = summaryLoading || analysisLoading;

  useEffect(() => {
    setMessages(loadStoredMessages(conversationId));
  }, [conversationId]);

  useEffect(() => {
    if (conversationId && messages.length > 0) {
      saveMessages(conversationId, messages);
    }
  }, [conversationId, messages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  const addMessage = useCallback((msg: Omit<ChatMessage, 'id' | 'createdAt'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const createdAt = new Date().toISOString();
    setMessages((prev) => [...prev, { ...msg, id, createdAt }]);
  }, []);

  const handleSummarize = async () => {
    if (!canRequest || !conversationId) return;
    setError(null);
    const userPrompt = `${t('messaging.aiChatPromptSummary', 'Summarize this chat')} (${messageLimit})`;
    addMessage({ role: 'user', content: userPrompt });
    setSummaryLoading(true);
    try {
      const { data } = await apiClient.post<{ summary?: string }>(
        `/api/messaging/conversations/${conversationId}/ai/summary`,
        { limit: messageLimit }
      );
      const text = data?.summary ?? '';
      addMessage({ role: 'assistant', content: text || t('messaging.summaryResult', 'Summary'), type: 'summary' });
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string; message?: string } } };
      const msg = err?.response?.data?.message || err?.response?.data?.error || (e instanceof Error ? e.message : 'Failed to summarize');
      setError(msg);
      addMessage({ role: 'assistant', content: `${t('common.error', 'Error')}: ${msg}` });
    } finally {
      setSummaryLoading(false);
    }
  };

  const handleGenerateAnalysis = async () => {
    if (!canRequest || !conversationId || !isLead) return;
    setError(null);
    const userPrompt = t('messaging.aiChatPromptDraft', 'Suggest a reply');
    addMessage({ role: 'user', content: userPrompt });
    setAnalysisLoading(true);
    try {
      const { data } = await apiClient.post<AnalysisPayload>(
        `/api/messaging/conversations/${conversationId}/ai/analysis`
      );
      const draft = data?.draft_message ?? '';
      addMessage({ role: 'assistant', content: draft || '—', type: 'draft' });
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string; message?: string } } };
      const msg = err?.response?.data?.message || err?.response?.data?.error || (e instanceof Error ? e.message : 'Failed to generate');
      setError(msg);
      addMessage({ role: 'assistant', content: `${t('common.error', 'Error')}: ${msg}` });
    } finally {
      setAnalysisLoading(false);
    }
  };

  const handleInsertDraftFromMessage = (content: string) => {
    if (content && onInsertDraft) onInsertDraft(content);
  };

  const formatMessageTime = (iso?: string) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const now = new Date();
      const sameDay = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      return sameDay ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Compact toolbar */}
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-border space-y-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleSummarize}
            disabled={!canRequest || loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border bg-muted/30 hover:bg-muted/60 text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {summaryLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
            {t('messaging.aiCmdSummaryShort', 'Summarize')}
          </button>
          <button
            type="button"
            onClick={handleGenerateAnalysis}
            disabled={!canRequest || !isLead || loading}
            title={!isLead ? t('messaging.aiDraftOnlyLeads', 'Available for leads only') : undefined}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border bg-muted/30 hover:bg-muted/60 text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {analysisLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {t('messaging.aiCmdDraftShort', 'Suggest reply')}
          </button>
        </div>
        {/* Message count chips */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground mr-0.5">{t('messaging.aiMsgCount', 'Messages')}:</span>
          {MESSAGE_LIMIT_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setMessageLimit(n)}
              className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors ${
                messageLimit === n
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        {error && <p className="text-[10px] text-destructive truncate">{error}</p>}
      </div>

      {/* Chat history */}
      <div className="flex-1 min-h-0 flex flex-col p-3">
        <div
          ref={scrollRef}
          className="flex-1 min-h-[80px] rounded-xl border border-border bg-muted/10 overflow-y-auto p-3 space-y-3"
        >
          {messages.length === 0 ? (
            <p className="text-[10px] text-muted-foreground text-center py-6">
              {t('messaging.aiChatPlaceholder', 'Use the buttons above to get a summary or suggested reply. History is saved for this chat.')}
            </p>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/40 text-foreground border border-border'
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                  {msg.role === 'assistant' && msg.type === 'draft' && msg.content && msg.content !== '—' && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-2 w-full gap-2"
                      onClick={() => handleInsertDraftFromMessage(msg.content)}
                    >
                      <MessageSquare className="w-3 h-3" />
                      {t('messaging.insertIntoMessage', 'Insert into message')}
                    </Button>
                  )}
                </div>
                {formatMessageTime(msg.createdAt) && (
                  <span className="text-[10px] text-muted-foreground mt-0.5 px-1">
                    {formatMessageTime(msg.createdAt)}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
        <div className="mt-2">
          <input
            type="text"
            value={assistantQuery}
            onChange={(e) => setAssistantQuery(e.target.value)}
            placeholder={t('messaging.aiChatInputPlaceholder', 'Ask the assistant...')}
            className="w-full px-3 py-2 rounded-xl border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
            disabled
          />
        </div>
      </div>

      {!canRequest && (
        <p className="shrink-0 px-3 pb-2 text-[10px] text-muted-foreground">
          {t('messaging.aiSelectChatHint', 'Select a chat to access AI tools.')}
        </p>
      )}
    </div>
  );
}
