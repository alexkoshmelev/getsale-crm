import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

const STORAGE_KEY = 'notifications-storage';

export interface NotificationItem {
  id: string;
  reminderId: string;
  title: string | null;
  remind_at: string;
  entity_type: string;
  entity_id: string;
}

interface NotificationsState {
  muted: boolean;
  toggleMuted: () => void;
  /** Напоминания, у которых наступило время (для панели уведомлений) */
  notificationItems: NotificationItem[];
  setNotificationItems: (items: NotificationItem[]) => void;
  /** Добавить/обновить список; возвращает true если появились новые (для звука) */
  mergeDueReminders: (reminders: { id: string; title: string | null; remind_at: string; entity_type: string; entity_id: string }[]) => boolean;
  markAllRead: () => void;
}

export const useNotificationsStore = create<NotificationsState>()(
  persist(
    (set, get) => ({
      muted: false,
      toggleMuted: () => set((s) => ({ muted: !s.muted })),
      notificationItems: [],
      setNotificationItems: (items) => set({ notificationItems: items }),
      mergeDueReminders: (reminders) => {
        const prev = get().notificationItems;
        const prevIds = new Set(prev.map((p) => p.id));
        const next: NotificationItem[] = reminders.map((r) => ({
          id: r.id,
          reminderId: r.id,
          title: r.title,
          remind_at: r.remind_at,
          entity_type: r.entity_type,
          entity_id: r.entity_id,
        }));
        const hasNew = next.some((n) => !prevIds.has(n.id));
        set({ notificationItems: next });
        return hasNew;
      },
      markAllRead: () => set({ notificationItems: [] }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' ? localStorage : (undefined as any)
      ),
      partialize: (s) => ({ muted: s.muted }),
    }
  )
);
