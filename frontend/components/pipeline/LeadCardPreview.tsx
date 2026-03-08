'use client';

import React from 'react';
import Link from 'next/link';
import type { Lead, Stage } from '@/lib/api/pipeline';
import { LeadAvatar } from './LeadAvatar';

function leadContactName(lead: Lead): string {
  const display = (lead.display_name ?? '').trim();
  if (display) return display;
  const parts = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
  return parts || (lead.username ?? '').trim() || (lead.email ?? '').trim() || (lead.telegram_id ?? '').trim() || '—';
}

export interface LeadCardPreviewProps {
  lead: Lead;
  stage: Stage | undefined;
  /** Formatted amount string (e.g. "1 000 €") or empty. */
  amountFormatted: string;
  /** Primary meta line (e.g. date or "3 d. in funnel"). */
  primaryMeta?: string;
  /** Secondary meta line (e.g. "3 d. in funnel" when primary is date). */
  secondaryMeta?: string;
  /** When true, primary meta gets warning-style color (e.g. long in funnel). */
  primaryMetaLong?: boolean;
  /** When true, secondary meta gets warning-style color. */
  secondaryMetaLong?: boolean;
  /** First BD account id for avatar (Telegram). */
  bdAccountId?: string | null;
  /** Optional left slot (e.g. GripVertical for kanban). */
  leftSlot?: React.ReactNode;
  /** Menu button + dropdown (e.g. open card, remove). */
  menu?: React.ReactNode;
  /** Layout: 'row' for list/kanban card, 'compact' for timeline cell. */
  layout?: 'row' | 'compact';
  /** Optional class for the card wrapper. */
  className?: string;
  /** Border left color (stage color). */
  stageColor?: string | null;
  /** If true, card is draggable (kanban). */
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}

export function LeadCardPreview({
  lead,
  stage,
  amountFormatted,
  primaryMeta,
  secondaryMeta,
  primaryMetaLong,
  secondaryMetaLong,
  bdAccountId,
  leftSlot,
  menu,
  layout = 'row',
  className = '',
  stageColor,
  draggable,
  onDragStart,
  onDragEnd,
}: LeadCardPreviewProps) {
  const stageName = stage?.name ?? '—';
  const content = (
    <>
      {leftSlot}
      <LeadAvatar lead={lead} bdAccountId={bdAccountId} className={layout === 'compact' ? 'w-8 h-8' : 'w-9 h-9'} />
      <div className="flex-1 min-w-0">
        <Link
          href={`/dashboard/messaging?contactId=${lead.contact_id}`}
          className="font-medium text-foreground hover:underline block truncate text-sm"
        >
          {leadContactName(lead)}
        </Link>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30">
            {stageName}
          </span>
          {amountFormatted && (
            <span className="text-[10px] text-muted-foreground">{amountFormatted}</span>
          )}
        </div>
        {(primaryMeta || secondaryMeta) && (
          <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground mt-0.5">
            {primaryMeta && (
              <span className={primaryMetaLong ? 'text-amber-600 dark:text-amber-400 font-medium' : undefined} title={primaryMeta}>
                {primaryMeta}
              </span>
            )}
            {secondaryMeta && (
              <span className={secondaryMetaLong ? 'text-amber-600 dark:text-amber-400 font-medium' : undefined} title={secondaryMeta}>
                {secondaryMeta}
              </span>
            )}
          </div>
        )}
      </div>
      {menu && <div className="relative shrink-0">{menu}</div>}
    </>
  );

  const baseClass = 'flex items-start gap-2 min-w-0 bg-card rounded-lg border border-border shadow-soft hover:shadow-soft-md hover:border-primary/30 transition-shadow';
  const borderStyle = stageColor ? { borderLeftColor: stageColor, borderLeftWidth: 4 } : undefined;

  const padding = layout === 'compact' ? 'p-2.5' : 'p-3';
  return (
    <div
      className={`${baseClass} ${padding} border-l-4 ${className}`}
      style={borderStyle}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {content}
    </div>
  );
}
