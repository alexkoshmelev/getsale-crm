'use client';

import { useState, useEffect, useCallback } from 'react';
import { ChevronRight, Bot, User } from 'lucide-react';

export type RightPanelTab = 'ai_assistant' | 'lead_card';

const STORAGE_TAB_KEY = 'messaging_right_panel_tab';
const PANEL_WIDTH_EXPANDED = 320;
const PANEL_WIDTH_COLLAPSED = 64;

const TABS: { id: RightPanelTab; icon: typeof Bot; labelKey: string }[] = [
  { id: 'ai_assistant', icon: Bot, labelKey: 'AI' },
  { id: 'lead_card', icon: User, labelKey: 'Lead' },
];

interface RightWorkspacePanelProps {
  hasChat: boolean;
  isLead: boolean;
  isOpen: boolean;
  onClose: () => void;
  activeTab: RightPanelTab | null;
  onTabChange: (tab: RightPanelTab) => void;
  leadCardContent: React.ReactNode;
  aiAssistantContent: React.ReactNode;
  /** Подписи табов (например из t('messaging.aiAssistant')) */
  tabLabels?: { ai: string; lead: string };
}

export function RightWorkspacePanel({
  hasChat,
  isLead,
  isOpen,
  onClose,
  activeTab,
  onTabChange,
  leadCardContent,
  aiAssistantContent,
  tabLabels = { ai: 'ИИ', lead: 'Лид' },
}: RightWorkspacePanelProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const persistTab = useCallback((tab: RightPanelTab) => {
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.setItem(STORAGE_TAB_KEY, tab);
      } catch (_) {}
    }
  }, []);

  const handleTabClick = useCallback(
    (tab: RightPanelTab) => {
      onTabChange(tab);
      persistTab(tab);
    },
    [onTabChange, persistTab]
  );

  const canOpenAI = hasChat;
  const canOpenLead = hasChat && isLead;

  if (!mounted) return null;

  const width = isOpen ? PANEL_WIDTH_EXPANDED : PANEL_WIDTH_COLLAPSED;

  return (
    <div
      className="h-full min-h-0 self-stretch bg-card border-l border-border flex flex-col transition-[width] duration-200 ease-out shrink-0 overflow-hidden"
      style={{ width }}
      aria-expanded={isOpen}
    >
      {isOpen ? (
        <>
          <div className="shrink-0 flex items-center justify-between gap-2 p-3 border-b border-border min-h-[3.5rem]">
            <div className="flex items-center gap-0.5 min-w-0">
              {TABS.map(({ id, icon: Icon, labelKey }) => {
                const label = labelKey === 'AI' ? tabLabels.ai : tabLabels.lead;
                const enabled = id === 'ai_assistant' ? canOpenAI : canOpenLead;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => enabled && handleTabClick(id)}
                    disabled={!enabled}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors shrink-0 ${
                      activeTab === id
                        ? 'bg-primary text-primary-foreground'
                        : enabled
                          ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
                          : 'opacity-50 cursor-not-allowed text-muted-foreground'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground shrink-0"
              title="Свернуть панель"
              aria-label="Свернуть панель"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            {activeTab === 'lead_card' && leadCardContent}
            {activeTab === 'ai_assistant' && aiAssistantContent}
          </div>
        </>
      ) : (
        <div className="flex flex-col flex-1 min-h-0 w-full py-2">
          {TABS.map(({ id, icon: Icon }) => {
            const enabled = id === 'ai_assistant' ? canOpenAI : canOpenLead;
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => enabled && handleTabClick(id)}
                disabled={!enabled}
                title={id === 'ai_assistant' ? tabLabels.ai : tabLabels.lead}
                className={`flex flex-col items-center justify-center w-full py-2.5 rounded-md transition-colors shrink-0 ${
                  enabled
                    ? isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    : 'opacity-50 cursor-not-allowed text-muted-foreground'
                }`}
              >
                <Icon className="w-5 h-5 shrink-0" aria-hidden />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function getPersistedRightPanelTab(): RightPanelTab | null {
  if (typeof window === 'undefined') return null;
  try {
    const t = sessionStorage.getItem(STORAGE_TAB_KEY);
    if (t === 'ai_assistant' || t === 'lead_card') return t;
  } catch (_) {}
  return null;
}
