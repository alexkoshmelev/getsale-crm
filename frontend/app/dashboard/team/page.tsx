'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { UserPlus, Users, Link2, Copy, Loader2, Trash2 } from 'lucide-react';
import { useAuthStore } from '@/lib/stores/auth-store';
import Button from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

interface TeamMember {
  id?: string;
  user_id: string;
  userId?: string;
  team_member_id?: string;
  role: string;
  team_name?: string;
  email?: string;
}

interface InviteLinkItem {
  id: string;
  token: string;
  role: string;
  expiresAt: string;
  createdAt: string;
  expired: boolean;
}

interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  teamName?: string;
}

const UNIFIED_ROLES: { value: string; labelKey: string }[] = [
  { value: 'owner', labelKey: 'team.roleOwner' },
  { value: 'admin', labelKey: 'team.adminRole' },
  { value: 'supervisor', labelKey: 'team.roleManager' },
  { value: 'bidi', labelKey: 'team.roleAgent' },
  { value: 'viewer', labelKey: 'team.roleViewer' },
];

export default function TeamPage() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const canChangeRoles = user?.role === 'owner' || user?.role === 'admin';
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('bidi');
  const [inviting, setInviting] = useState(false);
  const [inviteLinks, setInviteLinks] = useState<InviteLinkItem[]>([]);
  const [inviteLinksLoading, setInviteLinksLoading] = useState(true);
  const [creatingLink, setCreatingLink] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [updatingRoleId, setUpdatingRoleId] = useState<string | null>(null);
  const [pendingInvitations, setPendingInvitations] = useState<PendingInvitation[]>([]);
  const [pendingInvitationsLoading, setPendingInvitationsLoading] = useState(true);
  const [revokingInvitationId, setRevokingInvitationId] = useState<string | null>(null);

  useEffect(() => {
    fetchMembers();
  }, []);

  useEffect(() => {
    fetchInviteLinks();
  }, []);

  useEffect(() => {
    fetchPendingInvitations();
  }, []);

  const fetchPendingInvitations = async () => {
    setPendingInvitationsLoading(true);
    try {
      const response = await axios.get(`${API_URL}/api/team/invitations`);
      setPendingInvitations(Array.isArray(response.data) ? response.data : []);
    } catch (error) {
      console.error('Error fetching pending invitations:', error);
      setPendingInvitations([]);
    } finally {
      setPendingInvitationsLoading(false);
    }
  };

  const fetchInviteLinks = async () => {
    setInviteLinksLoading(true);
    try {
      const response = await axios.get(`${API_URL}/api/team/invite-links`);
      setInviteLinks(Array.isArray(response.data) ? response.data : []);
    } catch (error) {
      console.error('Error fetching invite links:', error);
      setInviteLinks([]);
    } finally {
      setInviteLinksLoading(false);
    }
  };

  const fetchMembers = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/team/members`);
      const list = Array.isArray(response.data) ? response.data : [];
      // Deduplicate by user_id (backend returns one per user; keep as safety if old data)
      const seen = new Set<string>();
      const deduped = list.filter((m: TeamMember) => {
        const id = m.user_id;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      setMembers(deduped);
    } catch (error) {
      console.error('Error fetching team members:', error);
      setMembers([]);
    } finally {
      setLoading(false);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviting(true);
    try {
      await axios.post(`${API_URL}/api/team/members/invite`, {
        email: inviteEmail,
        role: inviteRole,
        teamId: 'default',
      });
      setShowInviteModal(false);
      setInviteEmail('');
      setInviteRole('bidi');
      fetchMembers();
      fetchPendingInvitations();
    } catch (error) {
      console.error('Error inviting member:', error);
    } finally {
      setInviting(false);
    }
  };

  const handleCreateInviteLink = async () => {
    setCreatingLink(true);
    try {
      await axios.post(`${API_URL}/api/team/invite-links`, { expiresInDays: 7 });
      await fetchInviteLinks();
    } catch (error) {
      console.error('Error creating invite link:', error);
    } finally {
      setCreatingLink(false);
    }
  };

  const getInviteLinkUrl = (token: string) =>
    typeof window !== 'undefined' ? `${window.location.origin}/invite/${token}` : '';

  const handleCopyInviteLink = async (id: string, token: string) => {
    const url = getInviteLinkUrl(token);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (e) {
      console.error('Copy failed:', e);
    }
  };

  const handleRevokeInviteLink = async (id: string) => {
    setRevokingId(id);
    try {
      await axios.delete(`${API_URL}/api/team/invite-links/${id}`);
      setInviteLinks((prev) => prev.filter((l) => l.id !== id));
    } catch (error) {
      console.error('Error revoking invite link:', error);
    } finally {
      setRevokingId(null);
    }
  };

  const handleRevokeInvitation = async (id: string) => {
    setRevokingInvitationId(id);
    try {
      await axios.delete(`${API_URL}/api/team/invitations/${id}`);
      setPendingInvitations((prev) => prev.filter((inv) => inv.id !== id));
    } catch (error) {
      console.error('Error revoking invitation:', error);
    } finally {
      setRevokingInvitationId(null);
    }
  };

  const handleMemberRoleChange = async (member: TeamMember, newRole: string) => {
    const id = member.user_id ?? member.userId ?? member.team_member_id;
    if (!id) return;
    setUpdatingRoleId(id);
    try {
      await axios.put(`${API_URL}/api/team/members/${id}/role`, { role: newRole });
      await fetchMembers();
    } catch (error) {
      console.error('Error updating member role:', error);
    } finally {
      setUpdatingRoleId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[320px]">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent" aria-hidden />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight mb-1">
            {t('team.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('team.subtitle')}</p>
        </div>
        <Button onClick={() => setShowInviteModal(true)}>
          <UserPlus className="w-4 h-4 mr-2" />
          {t('team.invite')}
        </Button>
      </div>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Users className="w-5 h-5 text-muted-foreground shrink-0" />
          <h2 className="font-heading text-lg font-semibold text-foreground tracking-tight">
            {t('team.members')} ({members.length})
          </h2>
        </div>

        {members.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {members.map((member, index) => (
              <div
                key={member.team_member_id ?? member.user_id ?? `member-${index}`}
                className="p-4 rounded-xl border border-border hover:shadow-soft transition-shadow"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <Users className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground truncate">
                      {member.email || `User ${member.user_id?.slice(0, 8)}`}
                    </p>
                    {(member.team_member_id || member.user_id) ? (
                      canChangeRoles ? (
                        <select
                          value={['owner', 'admin', 'supervisor', 'bidi', 'viewer'].includes(member.role) ? member.role : 'bidi'}
                          onChange={(e) => handleMemberRoleChange(member, e.target.value)}
                          disabled={updatingRoleId === (member.team_member_id ?? member.user_id)}
                          className="mt-1 text-sm border border-input rounded px-2 py-1 bg-background text-foreground"
                        >
                          {UNIFIED_ROLES.map((r) => (
                            <option key={r.value} value={r.value}>{t(r.labelKey)}</option>
                          ))}
                        </select>
                      ) : (
                        <p className="text-sm text-muted-foreground">{t(UNIFIED_ROLES.find((r) => r.value === member.role)?.labelKey ?? 'team.roleAgent')}</p>
                      )
                    ) : (
                      <p className="text-sm text-muted-foreground">{t(UNIFIED_ROLES.find((r) => r.value === member.role)?.labelKey ?? 'team.roleAgent')}</p>
                    )}
                  </div>
                </div>
                {member.team_name && (
                  <p className="text-xs text-muted-foreground">{t('team.teamName')}: {member.team_name}</p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Users}
            title={t('team.noMembers')}
            description={t('team.noMembersHint')}
            action={
              <Button onClick={() => setShowInviteModal(true)}>
                <UserPlus className="w-4 h-4 mr-2" />
                {t('team.invite')}
              </Button>
            }
          />
        )}
      </Card>

      {(pendingInvitationsLoading || pendingInvitations.length > 0) && (
        <Card className="p-6">
          <div className="flex items-center gap-2 mb-2">
            <UserPlus className="w-5 h-5 text-muted-foreground shrink-0" />
            <h2 className="font-heading text-lg font-semibold text-foreground tracking-tight">
              {t('team.pendingInvitations')}
            </h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">{t('team.pendingInvitationsHint')}</p>
          {pendingInvitationsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>…</span>
            </div>
          ) : pendingInvitations.length > 0 ? (
            <ul className="space-y-2">
              {pendingInvitations.map((inv) => (
                <li
                  key={inv.id}
                  className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-lg border border-border bg-muted/20"
                >
                  <div>
                    <span className="font-medium text-foreground">{inv.email}</span>
                    <span className="text-sm text-muted-foreground ml-2">
                      {t(UNIFIED_ROLES.find((r) => r.value === inv.role)?.labelKey ?? 'team.roleAgent')}
                      {inv.teamName && ` · ${inv.teamName}`}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={() => handleRevokeInvitation(inv.id)}
                    disabled={revokingInvitationId === inv.id}
                  >
                    {revokingInvitationId === inv.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <>
                        <Trash2 className="w-3.5 h-3.5 mr-1" />
                        {t('team.revokeInvitation')}
                      </>
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      )}

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-2">
          <Link2 className="w-5 h-5 text-muted-foreground shrink-0" />
          <h2 className="font-heading text-lg font-semibold text-foreground tracking-tight">
            {t('team.inviteByLink')}
          </h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">{t('team.inviteByLinkHint')}</p>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <Button onClick={handleCreateInviteLink} disabled={creatingLink} variant="outline">
            {creatingLink ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t('common.loading')}
              </>
            ) : (
              <>
                <Link2 className="w-4 h-4 mr-2" />
                {t('team.createInviteLink')}
              </>
            )}
          </Button>
        </div>
        {inviteLinksLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>…</span>
          </div>
        ) : inviteLinks.length > 0 ? (
          <ul className="space-y-3">
            {inviteLinks.map((link) => (
              <li
                key={link.id}
                className="flex flex-wrap items-center gap-2 p-3 rounded-lg border border-border bg-muted/20"
              >
                <input
                  type="text"
                  readOnly
                  value={getInviteLinkUrl(link.token)}
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded border border-input bg-background text-foreground text-sm font-mono truncate"
                />
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {t('team.expiresAt', {
                    date: new Date(link.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' }),
                  })}
                </span>
                {link.expired && (
                  <span className="text-xs px-2 py-0.5 rounded bg-destructive/15 text-destructive font-medium">
                    {t('team.expired')}
                  </span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleCopyInviteLink(link.id, link.token)}
                  disabled={link.expired}
                >
                  <Copy className="w-3.5 h-3.5 mr-1" />
                  {copiedId === link.id ? t('common.copied') : t('team.copyLink')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => handleRevokeInviteLink(link.id)}
                  disabled={revokingId === link.id}
                >
                  {revokingId === link.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Modal
        isOpen={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        title={t('team.inviteMember')}
        size="sm"
      >
        <form onSubmit={handleInvite} className="space-y-4">
          <Input
            label={t('auth.email')}
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            required
            placeholder="user@example.com"
          />
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">{t('team.role')}</label>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-ring focus:border-transparent"
            >
              {UNIFIED_ROLES.filter((r) => r.value !== 'owner').map((r) => (
                <option key={r.value} value={r.value}>{t(r.labelKey)}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" className="flex-1" onClick={() => setShowInviteModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" className="flex-1" disabled={inviting}>
              {inviting ? t('common.loading') : t('team.invite')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
