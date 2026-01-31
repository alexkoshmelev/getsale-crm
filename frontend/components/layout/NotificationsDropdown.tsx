'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, CheckCheck } from 'lucide-react';
import { clsx } from 'clsx';

export function NotificationsDropdown() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={t('nav.notifications')}
      >
        <Bell className="w-5 h-5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-80 rounded-xl border border-border bg-card shadow-soft-lg overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="font-heading text-sm font-semibold text-foreground">{t('nav.notifications')}</span>
            <button
              type="button"
              className="text-xs text-primary hover:underline"
            >
              {t('global.notificationsMarkRead')}
            </button>
          </div>
          <div className="p-6 text-center">
            <Bell className="w-10 h-10 text-muted-foreground/50 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">{t('global.notificationsEmpty')}</p>
            <p className="text-xs text-muted-foreground mt-1">Notifications will appear here when backend is connected.</p>
          </div>
        </div>
      )}
    </div>
  );
}
