'use client';

import React, { useRef, useEffect, useState } from 'react';

export interface ContextMenuProps {
  open: boolean;
  onClose: () => void;
  x: number;
  y: number;
  className?: string;
  children: React.ReactNode;
  /** Оценка высоты меню в px (для расчёта позиции до измерения). Если не задано, используется ref. */
  estimatedHeight?: number;
}

const MENU_PADDING = 8;
const DEFAULT_ESTIMATED_HEIGHT = 280;

/**
 * Переиспользуемое контекстное меню: позиция по клику (x, y), закрытие по onClose.
 * Меню не выходит за пределы экрана: при необходимости открывается вверх и/или сдвигается по горизонтали.
 */
export function ContextMenu({
  open,
  onClose,
  x,
  y,
  className = '',
  children,
  estimatedHeight = DEFAULT_ESTIMATED_HEIGHT,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const height = el ? el.getBoundingClientRect().height : estimatedHeight;
    const width = el ? el.getBoundingClientRect().width : 200;
    const winH = window.innerHeight;
    const winW = window.innerWidth;

    let left = x;
    let top = y;

    if (top + height + MENU_PADDING > winH) top = Math.max(MENU_PADDING, winH - height - MENU_PADDING);
    else if (top < MENU_PADDING) top = MENU_PADDING;

    if (left + width + MENU_PADDING > winW) left = Math.max(MENU_PADDING, winW - width - MENU_PADDING);
    else if (left < MENU_PADDING) left = MENU_PADDING;

    setPosition({ left, top });
  }, [open, x, y, estimatedHeight]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      className={`fixed z-[100] min-w-[140px] py-1 bg-popover border border-border rounded-lg shadow-lg ${className}`}
      style={{ left: position.left, top: position.top }}
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
