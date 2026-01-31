'use client';

import { LucideIcon } from 'lucide-react';
import { ReactNode } from 'react';
import { clsx } from 'clsx';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center py-14 px-6 text-center',
        className
      )}
    >
      <div className="rounded-2xl bg-muted/80 p-5 mb-5 ring-1 ring-border/50">
        <Icon className="w-11 h-11 text-muted-foreground" />
      </div>
      <h3 className="font-heading text-lg font-semibold text-foreground tracking-tight mb-1.5">{title}</h3>
      {description && (
        <p className="text-sm text-muted-foreground max-w-sm mb-5 leading-relaxed">{description}</p>
      )}
      {action}
    </div>
  );
}
