'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/stores/auth-store';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { WebSocketProvider } from '@/lib/contexts/websocket-context';
import { apiClient } from '@/lib/api/client';

export default function DashboardLayoutWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { isAuthenticated, user, refreshUser } = useAuthStore();
  const [isChecking, setIsChecking] = useState(true);

  // Always fetch /api/auth/me on load so server (cookie) is source of truth for current workspace.
  // Persisted user in localStorage can be stale after switch-workspace + reload.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.get('/api/auth/me');
        if (!cancelled && res.data?.id) {
          useAuthStore.setState({
            user: {
              id: res.data.id,
              email: res.data.email,
              organizationId: res.data.organizationId ?? res.data.organization_id,
              role: res.data.role ?? '',
            },
            isAuthenticated: true,
          });
        } else if (!cancelled && !res.data?.id) {
          useAuthStore.setState({ user: null, isAuthenticated: false });
          router.push('/auth/login');
        }
      } catch {
        if (!cancelled) {
          useAuthStore.setState({ user: null, isAuthenticated: false });
          router.push('/auth/login');
        }
      } finally {
        if (!cancelled) setIsChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [router]);

  if (isChecking) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAuthenticated && !user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <WebSocketProvider>
      <DashboardLayout>{children}</DashboardLayout>
    </WebSocketProvider>
  );
}

