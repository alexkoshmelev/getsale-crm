'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/lib/api/client';
import { useAuthStore } from '@/lib/stores/auth-store';
import Button from '@/components/ui/Button';
import { Loader2, Users } from 'lucide-react';

interface InviteInfo {
  organizationId: string;
  organizationName: string;
  role: string;
  expiresAt: string;
}

export default function InvitePage() {
  const params = useParams();
  const { t } = useTranslation();
  const token = params?.token as string;
  const isLoggedIn = useAuthStore((s) => !!s.accessToken);
  const fetchWorkspaces = useAuthStore((s) => s.fetchWorkspaces);
  const switchWorkspace = useAuthStore((s) => s.switchWorkspace);
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError(t('invitePage.invalidLink'));
      return;
    }
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    fetch(`${apiUrl}/api/invite/${token}`)
      .then((r) => (r.ok ? r.json() : Promise.reject({ status: r.status, data: {} })))
      .then((data: InviteInfo) => setInvite(data))
      .catch((err: { status?: number }) => {
        const status = err?.status;
        if (status === 404) setError(t('invitePage.notFound'));
        else if (status === 410) setError(t('invitePage.expired'));
        else setError(t('invitePage.notFound'));
      })
      .finally(() => setLoading(false));
  }, [token, t]);

  const handleAccept = async () => {
    if (!token || !invite) return;
    setAccepting(true);
    setError(null);
    try {
      await apiClient.post(`/api/invite/${token}/accept`);
      await fetchWorkspaces();
      await switchWorkspace(invite.organizationId);
    } catch (err: any) {
      const msg = err.response?.data?.error;
      setError(msg || t('invitePage.failedToJoin'));
    } finally {
      setAccepting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error && !invite) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="text-center max-w-md">
          <p className="text-destructive font-medium mb-4">{error}</p>
          <Link href="/auth/login" className="text-primary hover:underline">
            {t('invitePage.goToLogin')}
          </Link>
        </div>
      </div>
    );
  }

  if (!invite) return null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-12">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-primary/10 pointer-events-none" aria-hidden />
      <div className="relative w-full max-w-md p-8 bg-card rounded-2xl shadow-lg border border-border">
        <div className="flex justify-center mb-6">
          <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
            <Users className="w-7 h-7 text-primary" />
          </div>
        </div>
        <h1 className="text-xl font-semibold text-center text-foreground mb-2">
          {t('invitePage.title')}
        </h1>
        <p className="text-center text-muted-foreground mb-6">
          {t('invitePage.description', { name: invite.organizationName })}
        </p>
        {error && (
          <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm text-center">
            {error}
          </div>
        )}
        {isLoggedIn ? (
          <Button
            className="w-full"
            onClick={handleAccept}
            disabled={accepting}
          >
            {accepting ? <Loader2 className="w-5 h-5 animate-spin" /> : t('invitePage.join')}
          </Button>
        ) : (
          <div className="space-y-3 text-center">
            <p className="text-sm text-muted-foreground">
              {t('invitePage.signInOrSignUp')}
            </p>
            <div className="flex gap-3 justify-center">
              <Link href={`/auth/login?redirect=/invite/${token}`}>
                <Button variant="outline">{t('invitePage.login')}</Button>
              </Link>
              <Link href={`/auth/signup?invite=${token}`}>
                <Button>{t('invitePage.signUp')}</Button>
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
