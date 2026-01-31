'use client';

import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { useToast, type ToastItem } from '@/lib/contexts/toast-context';
import { clsx } from 'clsx';

function ToastEl({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const icons = {
    success: CheckCircle2,
    error: AlertCircle,
    info: Info,
    default: Info,
  };
  const Icon = icons[item.type];
  const styles = {
    success: 'bg-success/10 border-success/30 text-success dark:bg-success/20 dark:text-success',
    error: 'bg-destructive/10 border-destructive/30 text-destructive',
    info: 'bg-primary/10 border-primary/30 text-primary dark:bg-primary/20 dark:text-primary',
    default: 'bg-muted border-border text-foreground',
  };

  return (
    <div
      role="alert"
      className={clsx(
        'flex items-center gap-3 rounded-xl border px-4 py-3 shadow-soft-md min-w-[280px] max-w-[420px] animate-in slide-in-from-right-full duration-200',
        styles[item.type]
      )}
    >
      <Icon className="w-5 h-5 shrink-0" />
      <p className="text-sm font-medium flex-1">{item.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 p-1 rounded-lg opacity-70 hover:opacity-100 transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="Close"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
    >
      <div className="pointer-events-auto flex flex-col gap-2">
        {toasts.map((item) => (
          <ToastEl key={item.id} item={item} onDismiss={() => removeToast(item.id)} />
        ))}
      </div>
    </div>
  );
}
