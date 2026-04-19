'use client';

import { useMemo } from 'react';
import { clsx } from 'clsx';
import { BdAccountAvatar } from '@/components/bd-accounts/BdAccountAvatar';
import type { CampaignBdAccount } from '@/lib/api/campaigns';
import { campaignBdAccountToBDAccount } from '@/lib/campaign-bd-account';
import { getAccountDisplayName } from '@/lib/bd-account-display';
import { getAccountStatusRingVariant } from '@/lib/bd-account-health';

export interface AccountStatusAvatarProps {
  accountId: string;
  account: CampaignBdAccount;
  size?: 'sm' | 'md';
  className?: string;
  showTooltip?: boolean;
}

const ringClass: Record<'green' | 'yellow' | 'red', string> = {
  green: 'ring-2 ring-green-500 ring-offset-2 ring-offset-background',
  yellow: 'ring-2 ring-yellow-500 ring-offset-2 ring-offset-background',
  red: 'ring-2 ring-red-500 ring-offset-2 ring-offset-background',
};

const sizeClass: Record<'sm' | 'md', string> = {
  sm: 'w-7 h-7',
  md: 'w-10 h-10',
};

export function AccountStatusAvatar({
  accountId,
  account,
  size = 'md',
  className,
  showTooltip = false,
}: AccountStatusAvatarProps) {
  const bd = useMemo(() => campaignBdAccountToBDAccount(account), [account]);
  const ring = getAccountStatusRingVariant(bd);
  const label = getAccountDisplayName({
    id: accountId,
    display_name: account.displayName,
    first_name: account.firstName,
    last_name: account.lastName,
    username: account.username,
    phone_number: account.phoneNumber,
    telegram_id: account.telegramId,
  });

  return (
    <div
      className={clsx('rounded-full shrink-0', ringClass[ring], className)}
      title={showTooltip ? label : undefined}
    >
      <BdAccountAvatar accountId={accountId} account={bd} className={clsx('rounded-full', sizeClass[size])} />
    </div>
  );
}
