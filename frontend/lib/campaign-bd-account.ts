import type { CampaignBdAccount } from '@/lib/api/campaigns';
import type { BDAccount } from '@/lib/types/bd-account';

/** Maps API campaign BD payload to full `BDAccount` shape for health/avatar helpers. */
export function campaignBdAccountToBDAccount(acc: CampaignBdAccount): BDAccount {
  return {
    id: acc.id,
    telegram_id: acc.telegramId ?? '',
    is_active: acc.isActive,
    created_at: '',
    display_name: acc.displayName,
    first_name: acc.firstName ?? null,
    last_name: acc.lastName ?? null,
    username: acc.username ?? null,
    phone_number: acc.phoneNumber ?? null,
    photo_file_id: acc.photoFileId ?? null,
    flood_wait_until: acc.floodWaitUntil ?? null,
    flood_wait_seconds: acc.floodWaitSeconds ?? null,
    flood_reason: acc.floodReason ?? null,
    flood_last_at: acc.floodLastAt ?? null,
    spam_restricted_at: acc.spamRestrictedAt ?? null,
    spam_restriction_source: acc.spamRestrictionSource ?? null,
    peer_flood_count_1h: acc.peerFloodCount1h ?? null,
    connection_state: acc.connectionState as BDAccount['connection_state'],
  };
}
