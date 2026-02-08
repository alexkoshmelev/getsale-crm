'use client';

import React from 'react';

export interface ContextMenuProps {
  open: boolean;
  onClose: () => void;
  x: number;
  y: number;
  className?: string;
  children: React.ReactNode;
}

/**
 * Переиспользуемое контекстное меню: позиция по клику (x, y), закрытие по onClose.
 * Рендерит контейнер с фиксированной позицией; содержимое задаётся через children
 * (ContextMenuSection, ContextMenuItem или произвольные узлы).
 */
export function ContextMenu({ open, onClose, x, y, className = '', children }: ContextMenuProps) {
  if (!open) return null;
  return (
    <div
      className={`fixed z-[100] min-w-[140px] py-1 bg-popover border border-border rounded-lg shadow-lg ${className}`}
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      role="menu"
    >
      {children}
    </div>
  );
}

export interface ContextMenuSectionProps {
  label?: string;
  /** Не рисовать border-t перед заголовком (для первой секции в меню) */
  noTopBorder?: boolean;
  children: React.ReactNode;
}

export function ContextMenuSection({ label, noTopBorder, children }: ContextMenuSectionProps) {
  return (
    <>
      {label != null && (
        <div className={`px-3 py-2 text-xs font-medium text-muted-foreground ${noTopBorder ? '' : 'border-t border-border'}`}>
          {label}
        </div>
      )}
      {children}
    </>
  );
}

export interface ContextMenuItemProps {
  label?: React.ReactNode;
  onClick?: () => void;
  icon?: React.ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  children?: React.ReactNode;
  className?: string;
}

export function ContextMenuItem({
  label,
  onClick,
  icon,
  destructive,
  disabled,
  children,
  className = '',
}: ContextMenuItemProps) {
  const content = children ?? (
    <>
      {icon}
      {label}
    </>
  );
  return (
    <button
      type="button"
      className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 ${destructive ? 'text-destructive hover:bg-destructive/10' : 'hover:bg-accent'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
      role="menuitem"
    >
      {content}
    </button>
  );
}
