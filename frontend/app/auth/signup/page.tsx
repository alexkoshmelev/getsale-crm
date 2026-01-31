'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/lib/stores/auth-store';
import Link from 'next/link';
import { Input } from '@/components/ui/Input';
import Button from '@/components/ui/Button';

export default function SignupPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const signup = useAuthStore((state) => state.signup);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await signup(email, password, organizationName);
      router.push('/dashboard');
    } catch (err: unknown) {
      setError((err as { message?: string })?.message || t('auth.signupError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-12">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-primary/10 dark:from-primary/10 dark:via-background dark:to-primary/5 pointer-events-none" aria-hidden />
      <div className="relative w-full max-w-md p-8 bg-card rounded-2xl shadow-soft-lg border border-border">
        <div className="text-center mb-8">
          <h1 className="font-heading text-3xl font-bold text-foreground tracking-tight mb-2">
            {t('auth.signupTitle')}
          </h1>
          <p className="text-muted-foreground text-sm">{t('auth.signupCta')}</p>
        </div>

        {error && (
          <div className="mb-5 p-3.5 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <Input
            id="organizationName"
            type="text"
            label={t('auth.organizationName')}
            value={organizationName}
            onChange={(e) => setOrganizationName(e.target.value)}
            required
            placeholder="My Company"
            autoComplete="organization"
          />
          <Input
            id="email"
            type="email"
            label={t('auth.email')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="your@email.com"
            autoComplete="email"
          />
          <Input
            id="password"
            type="password"
            label={t('auth.password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            placeholder="••••••••"
            autoComplete="new-password"
          />
          <Button type="submit" disabled={loading} className="w-full h-11">
            {loading ? t('auth.signupLoading') : t('auth.signup')}
          </Button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t('auth.hasAccount')}{' '}
            <Link href="/auth/login" className="text-primary hover:underline font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded">
              {t('auth.loginLink')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
