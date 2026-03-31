'use client';

import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { AccountStatusAvatar } from '@/components/bd-accounts/AccountStatusAvatar';
import type { CampaignBdAccount } from '@/lib/api/campaigns';
import { campaignBdAccountToBDAccount } from '@/lib/campaign-bd-account';
import { isFloodActive } from '@/lib/bd-account-health';
import { CampaignFloodCountdownBadge } from '@/components/campaigns/CampaignFloodCountdownBadge';

export function CampaignSendingAccountsOverview({ accounts }: { accounts: CampaignBdAccount[] }) {
  const { t } = useTranslation();
  if (!accounts.length) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground mb-3">{t('campaigns.sendingAccounts')}</h3>
      <ul className="space-y-3">
        {accounts.map((acc) => {
          const bd = campaignBdAccountToBDAccount(acc);
          const floodOn = isFloodActive(bd);
          const conn = acc.connectionState;
          const showDisconnected =
            !floodOn && (conn === 'disconnected' || conn === 'reauth_required');

          return (
            <li key={acc.id} className="flex flex-wrap items-center gap-3">
              <AccountStatusAvatar accountId={acc.id} account={acc} size="md" showTooltip />
              <Link
                href={`/dashboard/bd-accounts/${acc.id}`}
                className="text-sm font-medium text-foreground hover:text-primary hover:underline"
              >
                {acc.displayName}
              </Link>
              {floodOn && acc.floodWaitUntil && <CampaignFloodCountdownBadge floodWaitUntil={acc.floodWaitUntil} />}
              {showDisconnected && (
                <span className="inline-flex items-center rounded-md border border-red-500/50 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-800 dark:text-red-200">
                  {t('campaigns.accountDisconnected')}
                  {conn ? ` (${conn})` : ''}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
