'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
import { Bell } from 'lucide-react';
import { clsx } from 'clsx';
import { useNotificationsStore } from '@/lib/stores/notifications-store';
import { fetchDueReminders, updateReminder } from '@/lib/api/crm';
import { playNotificationSound } from '@/lib/notification-sound';
import { formatShortDateTime } from '@/lib/format/date';

/** Background poll — not on the critical path for first paint / home dashboard. */
const POLL_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 2_500;

export function NotificationsDropdown() {
  const { t } = useTranslation();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const {
    muted,
    notificationItems,
    mergeDueReminders,
    markAllRead,
  } = useNotificationsStore();

  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const fetchDue = useCallback(() => {
    fetchDueReminders({ limit: 50 })
      .then((rows) => {
        const list = rows.map((r) => ({
          id: r.id,
          title: r.title ?? null,
          remind_at: typeof r.remind_at === 'string' ? r.remind_at : new Date(r.remind_at).toISOString(),
          entity_type: r.entity_type,
          entity_id: r.entity_id,
        }));
        const hasNew = mergeDueReminders(list);
        if (hasNew && !mutedRef.current) {
          playNotificationSound();
        }
      })
      .catch(() => {});
  }, [mergeDueReminders]);

  // Defer first CRM hit so the active route (e.g. home stats) is not competing for connections.
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const initialTimer = window.setTimeout(() => {
      fetchDue();
      intervalId = setInterval(fetchDue, POLL_INTERVAL_MS);
    }, INITIAL_DELAY_MS);
    return () => {
      window.clearTimeout(initialTimer);
      if (intervalId) clearInterval(intervalId);
    };
  }, [fetchDue]);

  // Fresh data when the user opens the panel (may be before the delayed background fetch).
  useEffect(() => {
    if (open) fetchDue();
  }, [open, fetchDue]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  const handleMarkAllRead = async () => {
    if (notificationItems.length === 0) {
      markAllRead();
      return;
    }
    setMarkingRead(true);
    try {
      await Promise.all(
        notificationItems.map((item) => updateReminder(item.reminderId, { done: true }))
      );
      markAllRead();
      setOpen(false);
    } finally {
      setMarkingRead(false);
    }
  };

  const count = notificationItems.length;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={t('nav.notifications')}
      >
        <Bell className="w-5 h-5" />
        {count > 0 && (
          <span
            className={clsx(
              'absolute -top-0.5 -right-0.5 min-w-[1.25rem] h-5 px-1 flex items-center justify-center rounded-full text-[10px] font-semibold bg-primary text-primary-foreground',
              count > 99 && 'text-[9px]'
            )}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-80 rounded-xl border border-border bg-card shadow-soft-lg overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="font-heading text-sm font-semibold text-foreground">{t('nav.notifications')}</span>
            {count > 0 && (
              <button
                type="button"
                disabled={markingRead}
                onClick={handleMarkAllRead}
                className="text-xs text-primary hover:underline disabled:opacity-50"
              >
                {markingRead ? '…' : t('global.notificationsMarkRead')}
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {count === 0 ? (
              <div className="p-6 text-center">
                <Bell className="w-10 h-10 text-muted-foreground/50 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">{t('global.notificationsEmpty')}</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {notificationItems.map((item) => (
                  <li
                    key={item.id}
                    className="px-4 py-3 hover:bg-muted/50 cursor-pointer transition-colors"
                    onClick={() => {
                      if (item.entity_type === 'contact') {
                        router.push(`/dashboard/messaging?contactId=${item.entity_id}`);
                      } else if (item.entity_type === 'deal') {
                        router.push(`/dashboard/pipeline?dealId=${item.entity_id}`);
                      }
                      setOpen(false);
                    }}
                  >
                    <p className="text-sm font-medium text-foreground truncate">
                      {item.title || t('crm.reminder', 'Напоминание')}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatShortDateTime(item.remind_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
