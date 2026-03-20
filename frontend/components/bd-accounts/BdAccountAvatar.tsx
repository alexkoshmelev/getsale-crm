'use client';

import React, { useEffect, useRef, useState } from 'react';
import { fetchBdAccountAvatarBlob } from '@/lib/api/bd-accounts';
import { blobUrlCache, avatarAccountKey } from '@/lib/cache/blob-url-cache';
import type { BDAccount } from '@/lib/types/bd-account';
import { getAccountInitials } from '@/lib/bd-account-display';

export interface BdAccountAvatarProps {
  accountId: string;
  account: BDAccount;
  className?: string;
}

function BdAccountAvatarInner({ accountId, account, className = 'w-10 h-10' }: BdAccountAvatarProps) {
  const [src, setSrc] = useState<string | null>(null);
  const mounted = useRef(true);
  const key = avatarAccountKey(accountId);

  useEffect(() => {
    mounted.current = true;
    const cached = blobUrlCache.get(key);
    if (cached) {
      setSrc(cached);
      return () => {
        mounted.current = false;
        setSrc(null);
      };
    }
    fetchBdAccountAvatarBlob(accountId)
      .then((blob) => {
        if (mounted.current && blob) {
          const u = URL.createObjectURL(blob);
          blobUrlCache.set(key, u);
          setSrc(u);
        }
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      setSrc(null);
    };
  }, [accountId, key]);

  const initials = getAccountInitials(account);
  if (src) {
    return <img src={src} alt="" className={`rounded-full object-cover bg-muted shrink-0 ${className}`} />;
  }
  return (
    <div
      className={`rounded-full bg-primary/15 flex items-center justify-center text-primary font-semibold text-sm shrink-0 ${className}`}
    >
      {initials}
    </div>
  );
}

export const BdAccountAvatar = React.memo(BdAccountAvatarInner);
