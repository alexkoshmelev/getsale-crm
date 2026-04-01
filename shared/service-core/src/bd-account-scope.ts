/**
 * BD Telegram account list visibility by user role (aligned with role_permissions).
 * Used by bd-accounts-service and campaign-service so listing stays consistent.
 */

/** Agent (bidi) role: can use only accounts they connected themselves. */
export const BIDI_ROLE = 'bidi';

/** Viewer: below agent; no BD Telegram accounts in lists. */
export const VIEWER_ROLE = 'viewer';

/** True for BD agents only (not owner/admin/supervisor/viewer). */
export function isBdAgentRole(role: string | undefined | null): boolean {
  return (role || '').toLowerCase() === BIDI_ROLE;
}

export function isBdViewerRole(role: string | undefined | null): boolean {
  return (role || '').toLowerCase() === VIEWER_ROLE;
}

export type BdAccountsListScope = 'all' | 'own_only' | 'none';

/** Who can see which BD accounts: viewer none; agent own only; owner/admin/supervisor all org accounts. */
export function bdAccountsListScope(role: string | undefined | null): BdAccountsListScope {
  if (isBdViewerRole(role)) return 'none';
  if (isBdAgentRole(role)) return 'own_only';
  return 'all';
}
