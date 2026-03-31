'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

function formatRemainingMs(ms: number, t: (k: string, o?: Record<string, number | string>) => string): string {
  if (ms <= 0) return '';
  const sec = Math.ceil(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return t('bdAccounts.floodWaitRemainingHms', { h, m, s });
  if (m > 0) return t('bdAccounts.floodWaitRemainingMs', { m, s });
  return t('bdAccounts.floodWaitRemainingS', { s });
}

/** Compact FLOOD_WAIT countdown for campaign overview (updates every second). */
export function CampaignFloodCountdownBadge({ floodWaitUntil }: { floodWaitUntil: string }) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const until = new Date(floodWaitUntil).getTime();
  const ms = until - Date.now();
  if (!Number.isFinite(until) || ms <= 0) return null;
  return (
    <span className="inline-flex items-center rounded-md border border-yellow-500/50 bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-900 dark:text-yellow-100">
      {t('campaigns.accountFlood')} — {t('campaigns.floodEndsIn', { time: formatRemainingMs(ms, t) })}
    </span>
  );
}
