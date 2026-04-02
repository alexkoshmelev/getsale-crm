'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountStatusAvatar } from '@/components/bd-accounts/AccountStatusAvatar';
import type { CampaignBdAccount } from '@/lib/api/campaigns';
import { pauseCampaignAccount, resumeCampaignAccount, removeCampaignAccount } from '@/lib/api/campaigns';
import { postSpamBotCheck } from '@/lib/api/bd-accounts';
import { campaignBdAccountToBDAccount } from '@/lib/campaign-bd-account';
import { isFloodActive, isSpamRestricted } from '@/lib/bd-account-health';
import { CampaignFloodCountdownBadge } from '@/components/campaigns/CampaignFloodCountdownBadge';
import { Button } from '@/components/ui/Button';

export function CampaignSendingAccountsOverview({
  accounts,
  campaignId,
  onChanged,
}: {
  accounts: CampaignBdAccount[];
  campaignId?: string;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);

  if (!accounts.length) return null;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      onChanged?.();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground mb-3">{t('campaigns.sendingAccounts')}</h3>
      <ul className="space-y-3">
        {accounts.map((acc) => {
          const bd = campaignBdAccountToBDAccount(acc);
          const floodOn = isFloodActive(bd);
          const spamOn = isSpamRestricted(bd);
          const conn = acc.connectionState;
          const showDisconnected =
            !floodOn && !spamOn && (conn === 'disconnected' || conn === 'reauth_required');
          const peerN = acc.peerFloodCount1h ?? 0;
          const keyBase = `${acc.id}`;
          const canActions = Boolean(campaignId);

          return (
            <li key={acc.id} className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
              <div className="flex flex-wrap items-center gap-3 min-w-0">
                <AccountStatusAvatar accountId={acc.id} account={acc} size="md" showTooltip />
                <Link
                  href={`/dashboard/bd-accounts/${acc.id}`}
                  className="text-sm font-medium text-foreground hover:text-primary hover:underline"
                >
                  {acc.displayName}
                </Link>
                {floodOn && acc.floodWaitUntil && <CampaignFloodCountdownBadge floodWaitUntil={acc.floodWaitUntil} />}
                {spamOn && (
                  <span className="inline-flex items-center rounded-md border border-red-500/50 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-800 dark:text-red-200">
                    {t('campaigns.accountSpamRestricted')}
                  </span>
                )}
                {!spamOn && peerN > 0 && (
                  <span className="inline-flex items-center rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-900 dark:text-amber-100">
                    {t('campaigns.accountPeerFloodWarning', { count: peerN })}
                  </span>
                )}
                {showDisconnected && (
                  <span className="inline-flex items-center rounded-md border border-red-500/50 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-800 dark:text-red-200">
                    {t('campaigns.accountDisconnected')}
                    {conn ? ` (${conn})` : ''}
                  </span>
                )}
              </div>
              {canActions && (
                <div className="flex flex-wrap gap-2 items-center">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void run(`${keyBase}-spam`, () => postSpamBotCheck(acc.id))}
                  >
                    {busy === `${keyBase}-spam` ? t('common.loading') : t('campaigns.spamBotRecheckAction')}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`${keyBase}-pause`, () => pauseCampaignAccount(campaignId!, acc.id))
                    }
                  >
                    {busy === `${keyBase}-pause` ? t('common.loading') : t('campaigns.pauseAccount')}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`${keyBase}-resume`, () => resumeCampaignAccount(campaignId!, acc.id))
                    }
                  >
                    {busy === `${keyBase}-resume` ? t('common.loading') : t('campaigns.resumeAccount')}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null || accounts.length <= 1}
                    title={accounts.length <= 1 ? t('campaigns.removeAccountNeedTwo') : undefined}
                    onClick={() => {
                      if (
                        !window.confirm(
                          t('campaigns.removeAccountConfirm', { name: acc.displayName || acc.id })
                        )
                      ) {
                        return;
                      }
                      void run(`${keyBase}-rm`, () => removeCampaignAccount(campaignId!, acc.id));
                    }}
                  >
                    {busy === `${keyBase}-rm` ? t('common.loading') : t('campaigns.removeAccount')}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
