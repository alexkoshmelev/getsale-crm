/** Minimal fields for display labels (API rows may use null vs undefined). */
export type BdAccountDisplaySource = {
  id: string;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  phone_number?: string | null;
  telegram_id?: string | null;
};

export function getAccountDisplayName(account: BdAccountDisplaySource): string {
  if (account.display_name?.trim()) return account.display_name.trim();
  const first = (account.first_name ?? '').trim();
  const last = (account.last_name ?? '').trim();
  if (first || last) return [first, last].filter(Boolean).join(' ');
  if (account.username?.trim()) return account.username.trim();
  if (account.phone_number?.trim()) return account.phone_number.trim();
  const tid = account.telegram_id?.trim();
  if (tid) return tid;
  return account.id;
}

export function getAccountInitials(account: BdAccountDisplaySource): string {
  const name = getAccountDisplayName(account);
  const parts = name.replace(/@/g, '').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase().slice(0, 2);
  if (name.length >= 2) return name.slice(0, 2).toUpperCase();
  return name.slice(0, 1).toUpperCase() || '?';
}
