'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { UserPlus, Users } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

interface TeamMember {
  id: string;
  user_id: string;
  role: string;
  team_name?: string;
  email?: string;
}

export default function TeamPage() {
  const { t } = useTranslation();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    fetchMembers();
  }, []);

  const fetchMembers = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/team/members`);
      setMembers(Array.isArray(response.data) ? response.data : []);
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
      setInviteRole('member');
      fetchMembers();
    } catch (error) {
      console.error('Error inviting member:', error);
    } finally {
      setInviting(false);
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
                key={member.id ?? member.user_id ?? `member-${index}`}
                className="p-4 rounded-xl border border-border hover:shadow-soft transition-shadow"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <Users className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-foreground truncate">
                      {member.email || `User ${member.user_id.slice(0, 8)}`}
                    </p>
                    <p className="text-sm text-muted-foreground capitalize">{member.role}</p>
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
              <option value="member">{t('team.memberRole')}</option>
              <option value="admin">{t('team.adminRole')}</option>
              <option value="supervisor">{t('team.supervisorRole')}</option>
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
