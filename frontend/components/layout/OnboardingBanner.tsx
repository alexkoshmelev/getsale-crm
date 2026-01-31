'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { X, Building2, MessageSquare, TrendingUp, Sparkles } from 'lucide-react';
import Button from '@/components/ui/Button';

const STORAGE_KEY = 'getsale-onboarding-dismissed';

export function OnboardingBanner() {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      setDismissed(stored === 'true');
    } catch {
      setDismissed(false);
    }
  }, []);

  const handleDismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
      setDismissed(true);
    } catch {}
  };

  if (dismissed) return null;

  const steps = [
    { key: 'step1', icon: Building2, href: '/dashboard/crm' },
    { key: 'step2', icon: MessageSquare, href: '/dashboard/bd-accounts' },
    { key: 'step3', icon: TrendingUp, href: '/dashboard/pipeline' },
  ];

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 dark:bg-primary/10 p-4 mb-6 animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="flex items-start gap-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
          <Sparkles className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-heading font-semibold text-foreground tracking-tight mb-1">
            {t('onboarding.welcome')}
          </h3>
          <p className="text-sm text-muted-foreground mb-4">{t('onboarding.welcomeDesc')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            {steps.map((step) => {
              const Icon = step.icon;
              return (
                <Link
                  key={step.key}
                  href={step.href}
                  className="flex items-center gap-2 p-3 rounded-lg border border-border bg-card hover:bg-accent transition-colors text-left"
                >
                  <Icon className="w-4 h-4 text-primary shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-foreground">{t(`onboarding.${step.key}Title`)}</p>
                    <p className="text-xs text-muted-foreground line-clamp-1">{t(`onboarding.${step.key}Desc`)}</p>
                  </div>
                </Link>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/dashboard/crm">
              <Button size="sm">{t('onboarding.getStarted')}</Button>
            </Link>
            <Button variant="ghost" size="sm" onClick={handleDismiss}>
              {t('onboarding.dismiss')}
            </Button>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0"
          aria-label={t('common.close')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
