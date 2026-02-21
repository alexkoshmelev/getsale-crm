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
