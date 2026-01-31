'use client';

import { createContext, useCallback, useContext, useState, ReactNode } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'default';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  createdAt: number;
}

interface ToastContextValue {
  toasts: ToastItem[];
  addToast: (message: string, type?: ToastType, duration?: number) => void;
  removeToast: (id: string) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastType = 'default', duration = DEFAULT_DURATION) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const item: ToastItem = { id, type, message, duration, createdAt: Date.now() };
      setToasts((prev) => [...prev.slice(-4), item]);
      if (duration > 0) {
        setTimeout(() => removeToast(id), duration);
      }
    },
    [removeToast]
  );

  const success = useCallback((message: string, duration?: number) => addToast(message, 'success', duration ?? DEFAULT_DURATION), [addToast]);
  const error = useCallback((message: string, duration?: number) => addToast(message, 'error', duration ?? 6000), [addToast]);
  const info = useCallback((message: string, duration?: number) => addToast(message, 'info', duration ?? DEFAULT_DURATION), [addToast]);

  const value: ToastContextValue = { toasts, addToast, removeToast, success, error, info };

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
