'use client';

import { Megaphone, Users, Lock, MessageCircle } from 'lucide-react';
import type { ResolvedSource } from '@/lib/api/discovery';

interface SourceTypeCardProps {
  source: ResolvedSource;
}

const typeConfig: Record<string, { icon: typeof Megaphone; label: string; bg: string }> = {
  channel: { icon: Megaphone, label: 'Канал', bg: 'bg-blue-100 dark:bg-blue-900/30' },
  public_group: { icon: Users, label: 'Публичная группа', bg: 'bg-green-100 dark:bg-green-900/30' },
  private_group: { icon: Lock, label: 'Закрытая группа', bg: 'bg-amber-100 dark:bg-amber-900/30' },
  comment_group: { icon: MessageCircle, label: 'Группа комментариев', bg: 'bg-purple-100 dark:bg-purple-900/30' },
  unknown: { icon: Users, label: 'Источник', bg: 'bg-gray-100 dark:bg-gray-700' },
};

export default function SourceTypeCard({ source }: SourceTypeCardProps) {
  if (source.error) {
    return (
      <div className="p-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 flex items-center gap-3">
        <span className="text-red-500 text-sm">{source.input}</span>
        <span className="text-red-600 dark:text-red-400 text-sm">{source.error}</span>
      </div>
    );
  }

  const config = typeConfig[source.type] ?? typeConfig.unknown;
  const Icon = config.icon;

  return (
    <div className={`p-3 rounded-lg border border-gray-200 dark:border-gray-700 ${config.bg} flex items-center gap-3`}>
      <div className="flex-shrink-0 w-10 h-10 rounded-full bg-white dark:bg-gray-800 flex items-center justify-center">
        <Icon className="w-5 h-5 text-gray-600 dark:text-gray-300" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-gray-900 dark:text-gray-100 truncate">{source.title || source.input}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {config.label}
          {source.username && ` • @${source.username}`}
          {source.membersCount != null && ` • ~${source.membersCount} участников`}
        </div>
      </div>
    </div>
  );
}
