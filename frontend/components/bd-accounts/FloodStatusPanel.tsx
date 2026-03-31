'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';

export interface FloodStatusPanelProps {
  flood_wait_until?: string | null;
  flood_reason?: string | null;
  flood_last_at?: string | null;
}

function formatDurationMs(ms: number, t: (k: string, o?: Record<string, number | string>) => string): string {
  if (ms <= 0) return t('bdAccounts.floodWaitRemainingDone');
  const sec = Math.ceil(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return t('bdAccounts.floodWaitRemainingHms', { h, m, s });
  if (m > 0) return t('bdAccounts.floodWaitRemainingMs', { m, s });
  return t('bdAccounts.floodWaitRemainingS', { s });
}

export function FloodStatusPanel({ flood_wait_until, flood_reason, flood_last_at }: FloodStatusPanelProps) {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);

  const until = flood_wait_until ? new Date(flood_wait_until) : null;
  const untilValid = until != null && !Number.isNaN(until.getTime());
  const floodActivePreview = untilValid && until.getTime() > Date.now();

  useEffect(() => {
    const ms = floodActivePreview ? 1000 : 30_000;
    const id = window.setInterval(() => setTick((x) => x + 1), ms);
    return () => window.clearInterval(id);
  }, [floodActivePreview]);

  const now = useMemo(() => new Date(), [tick]);

  const floodActive = untilValid && until != null && until > now;

  const docUrl = t('bdAccounts.floodWaitDocUrl').trim();
  const showDoc = /^https?:\/\//i.test(docUrl);

  const lastAt = flood_last_at ? new Date(flood_last_at) : null;
  const lastValid = lastAt && !Number.isNaN(lastAt.getTime());
  const recentClearedMs = 48 * 3600 * 1000;
  const showAfterFlood =
    !floodActive &&
    lastValid &&
    now.getTime() - lastAt!.getTime() < recentClearedMs &&
    now.getTime() - lastAt!.getTime() >= 0;

  if (floodActive) {
    const remainingMs = until!.getTime() - now.getTime();
    return (
      <div className="mt-4 rounded-lg border border-orange-200 dark:border-orange-900/50 bg-orange-50/80 dark:bg-orange-950/30 px-3 py-2 text-sm text-orange-950 dark:text-orange-100">
        <p className="font-medium">{t('bdAccounts.floodWaitTitle')}</p>
        <p className="mt-1 text-xs opacity-90">
          {t('bdAccounts.floodWaitUntil', {
            time: until!.toLocaleString(),
          })}
        </p>
        <p className="mt-1 text-xs font-medium">{formatDurationMs(remainingMs, t)}</p>
        {flood_reason?.trim() && (
          <p className="mt-1 text-xs font-mono opacity-80 break-all">{flood_reason.trim()}</p>
        )}
        <p className="mt-2 text-xs">{t('bdAccounts.floodWaitHint')}</p>
        {showDoc && (
          <a
            href={docUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            {t('bdAccounts.floodWaitDocLabel')}
          </a>
        )}
      </div>
    );
  }

  if (showAfterFlood) {
    return (
      <div className="mt-4 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-900/40 px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
        <p className="font-medium">{t('bdAccounts.floodAfterTitle')}</p>
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{t('bdAccounts.floodAfterBody')}</p>
        <ul className="mt-2 text-xs text-gray-600 dark:text-gray-400 list-disc list-inside space-y-1">
          <li>
            <Link href="/dashboard/bd-accounts/health" className="text-primary hover:underline">
              {t('bdAccounts.floodAfterLinkHealth')}
            </Link>
          </li>
          <li>
            <Link href="/dashboard/campaigns" className="text-primary hover:underline">
              {t('bdAccounts.floodAfterLinkCampaigns')}
            </Link>
          </li>
        </ul>
        {showDoc && (
          <a
            href={docUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            {t('bdAccounts.floodWaitDocLabel')}
          </a>
        )}
      </div>
    );
  }

  return null;
}
