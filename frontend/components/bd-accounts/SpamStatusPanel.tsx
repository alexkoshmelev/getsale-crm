'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BDAccount } from '@/lib/types/bd-account';
import { isSpamRestricted } from '@/lib/bd-account-health';
import { postSpamBotCheck, postSpamClear } from '@/lib/api/bd-accounts';
import { Button } from '@/components/ui/Button';

export interface SpamStatusPanelProps {
  account: BDAccount;
  accountId: string;
  onUpdated?: () => void;
}

export function SpamStatusPanel({ account, accountId, onUpdated }: SpamStatusPanelProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<'check' | 'clear' | null>(null);
  const restricted = isSpamRestricted(account);
  const peerN = account.peer_flood_count_1h ?? 0;
  const showPeerHint = !restricted && peerN > 0;

  if (!restricted && !showPeerHint && !account.last_spambot_check_at) {
    return null;
  }

  const runCheck = async () => {
    setBusy('check');
    try {
      await postSpamBotCheck(accountId);
      onUpdated?.();
    } finally {
      setBusy(null);
    }
  };

  const runClear = async () => {
    setBusy('clear');
    try {
      await postSpamClear(accountId);
      onUpdated?.();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={
        restricted
          ? 'mt-4 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50/80 dark:bg-red-950/30 px-3 py-2 text-sm text-red-950 dark:text-red-100'
          : showPeerHint
            ? 'mt-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/80 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-950 dark:text-amber-100'
            : 'mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm'
      }
    >
      {restricted && (
        <>
          <p className="font-medium">{t('bdAccounts.spamPanelTitleRestricted')}</p>
          <p className="mt-1 text-xs opacity-90">{t('bdAccounts.spamPanelBodyRestricted')}</p>
          {account.spam_restriction_source && (
            <p className="mt-1 text-xs opacity-80">
              {t('bdAccounts.spamPanelSource')}: {account.spam_restriction_source}
            </p>
          )}
        </>
      )}
      {showPeerHint && (
        <p className="font-medium">
          {t('bdAccounts.spamPanelPeerFloodHint', { count: peerN })}
        </p>
      )}
      {account.last_spambot_check_at && (
        <p className="mt-2 text-xs opacity-80">
          {t('bdAccounts.spamPanelLastCheck')}: {new Date(account.last_spambot_check_at).toLocaleString()}
        </p>
      )}
      {account.last_spambot_result?.trim() && (
        <p className="mt-1 text-xs opacity-80 break-words">{account.last_spambot_result.trim()}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={busy !== null} onClick={() => void runCheck()}>
          {busy === 'check' ? t('common.loading') : t('bdAccounts.spamCheckAction')}
        </Button>
        {restricted && (
          <Button type="button" variant="secondary" size="sm" disabled={busy !== null} onClick={() => void runClear()}>
            {busy === 'clear' ? t('common.loading') : t('bdAccounts.spamClearAction')}
          </Button>
        )}
      </div>
      <p className="mt-2 text-xs opacity-80">{t('bdAccounts.spamPanelDocHint')}</p>
    </div>
  );
}
