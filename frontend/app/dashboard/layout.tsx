'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/stores/auth-store';
import DashboardLayout from '@/components/layout/DashboardLayout';

export default function DashboardLayoutWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { isAuthenticated, accessToken, user } = useAuthStore();
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    // Check if we have stored auth data
    if (typeof window !== 'undefined') {
      const authStorage = localStorage.getItem('auth-storage');
      if (authStorage) {
        try {
          const auth = JSON.parse(authStorage);
          // If we have token and user in storage but isAuthenticated is false, restore it
          if (auth.state?.accessToken && auth.state?.user && !isAuthenticated) {
            useAuthStore.setState({
              isAuthenticated: true,
              accessToken: auth.state.accessToken,
              refreshToken: auth.state.refreshToken,
              user: auth.state.user,
            });
            setIsChecking(false);
            return;
          }
        } catch (error) {
          console.error('Error parsing auth storage:', error);
        }
      }
    }
    
    setIsChecking(false);
    
    // Only redirect if we're sure there's no auth
    if (!isAuthenticated && !accessToken && !user) {
      router.push('/auth/login');
    }
  }, [isAuthenticated, accessToken, user, router]);

  if (isChecking) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAuthenticated && !accessToken) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  return <DashboardLayout>{children}</DashboardLayout>;
}

