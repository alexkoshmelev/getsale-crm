/**
 * Role-based access helpers aligned with role_permissions (owner, admin, supervisor, bidi, viewer).
 * Used for UI visibility and actions; API enforces permissions separately.
 */
const ROLES = ['owner', 'admin', 'supervisor', 'bidi', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export function normalizeRole(role: string | undefined | null): Role | '' {
  if (!role || typeof role !== 'string') return '';
  const r = role.toLowerCase().trim();
  return ROLES.includes(r as Role) ? (r as Role) : '';
}

/** Workspace settings (update): owner, admin */
export function canAccessWorkspaceSettings(role: string | undefined | null): boolean {
  const r = normalizeRole(role);
  return r === 'owner' || r === 'admin';
}

/** Team: read for all; invite/change roles: owner, admin */
export function canAccessTeam(role: string | undefined | null): boolean {
  return !!normalizeRole(role) || role === 'owner' || role === 'admin';
}

export function canManageTeam(role: string | undefined | null): boolean {
  const r = normalizeRole(role);
  return r === 'owner' || r === 'admin';
}

/** Transfer ownership: only owner */
export function canTransferOwnership(role: string | undefined | null): boolean {
  return normalizeRole(role) === 'owner';
}

/** Leave workspace: any member except owner (owner must transfer first). */
export function canLeaveWorkspace(role: string | undefined | null): boolean {
  const r = normalizeRole(role);
  return r !== '' && r !== 'owner';
}

/**
 * Delete workspace: owner only (not admin, supervisor, bidi, or viewer).
 * Must match current JWT role for the active workspace.
 */
export function canDeleteWorkspace(role: string | undefined | null): boolean {
  return normalizeRole(role) === 'owner';
}

/** CRM (contacts, companies, deals): owner, admin, supervisor */
export function canManageCRM(role: string | undefined | null): boolean {
  const r = normalizeRole(role);
  return r === 'owner' || r === 'admin' || r === 'supervisor';
}

/** Campaigns: owner, admin, supervisor */
export function canManageCampaigns(role: string | undefined | null): boolean {
  const r = normalizeRole(role);
  return r === 'owner' || r === 'admin' || r === 'supervisor';
}

/**
 * Delete / duplicate / rename (any status): owner, admin, or author of the campaign.
 * Matches campaign-service ACL for destructive or ownership-sensitive actions.
 */
export function canManageCampaignLifecycle(
  role: string | undefined | null,
  userId: string | undefined | null,
  createdByUserId: string | null | undefined
): boolean {
  const r = normalizeRole(role);
  if (r === 'owner' || r === 'admin') return true;
  if (userId && createdByUserId && userId === createdByUserId) return true;
  return false;
}

/** Messaging: owner, admin, supervisor, bidi */
export function canManageMessaging(role: string | undefined | null): boolean {
  const r = normalizeRole(role);
  return r === 'owner' || r === 'admin' || r === 'supervisor' || r === 'bidi';
}

/** Analytics: owner, admin, supervisor */
export function canViewAnalytics(role: string | undefined | null): boolean {
  const r = normalizeRole(role);
  return r === 'owner' || r === 'admin' || r === 'supervisor';
}

/** BD agent (bidi): lists and actions are limited to accounts they connected. Other roles see all org BD accounts. */
export function isBdAgentRole(role: string | undefined | null): boolean {
  return normalizeRole(role) === 'bidi';
}

/** Viewer: below agent; no access to BD Telegram accounts (API returns empty list). */
export function isBdViewerRole(role: string | undefined | null): boolean {
  return normalizeRole(role) === 'viewer';
}

/** Whether the user may see action buttons for a BD account row (list/detail). */
export function canActOnBdAccountRow(
  role: string | undefined | null,
  account: { is_owner?: boolean }
): boolean {
  if (isBdViewerRole(role)) return false;
  if (isBdAgentRole(role)) return account.is_owner === true;
  return true;
}

/** BD accounts: owner, admin */
export function canManageBDAccounts(role: string | undefined | null): boolean {
  const r = normalizeRole(role);
  return r === 'owner' || r === 'admin';
}

/** Automation rules: owner, admin */
export function canManageAutomation(role: string | undefined | null): boolean {
  const r = normalizeRole(role);
  return r === 'owner' || r === 'admin';
}
