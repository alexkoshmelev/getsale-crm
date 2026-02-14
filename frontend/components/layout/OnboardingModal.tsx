'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { X, Building2, MessageSquare, TrendingUp, Sparkles, ChevronRight } from 'lucide-react';
import Button from '@/components/ui/Button';

const STORAGE_KEY = 'getsale-onboarding-dismissed';
export const ONBOARDING_RESTART_EVENT = 'onboarding-restart';

const STEPS = [
  { key: 'step1', icon: Building2, href: '/dashboard/crm', linkLabelKey: 'nav.crm' },
  { key: 'step2', icon: MessageSquare, href: '/dashboard/bd-accounts', linkLabelKey: 'nav.bdAccounts' },
  { key: 'step3', icon: TrendingUp, href: '/dashboard/pipeline', linkLabelKey: 'nav.pipeline' },
] as const;

export function OnboardingModal() {
  const { t } = useTranslation();
  const router = useRouter();
  const [dismissed, setDismissed] = useState(true);
  const [step, setStep] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      setDismissed(stored === 'true');
    } catch {
      setDismissed(false);
    }
    setMounted(true);
  }, []);

  useEffect(() => {
    const handleRestart = () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {}
      setDismissed(false);
      setStep(0);
    };
    window.addEventListener(ONBOARDING_RESTART_EVENT, handleRestart);
    return () => window.removeEventListener(ONBOARDING_RESTART_EVENT, handleRestart);
  }, []);

  const handleDismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
      setDismissed(true);
    } catch {}
  };

  const handleGetStarted = () => {
    handleDismiss();
    router.push(STEPS[0].href);
  };

  const handleGoToStep = (href: string) => {
    handleDismiss();
    router.push(href);
  };

  if (!mounted || dismissed) return null;

  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-[100] animate-in fade-in duration-200" aria-hidden />
      <div
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[101] w-full max-w-lg bg-card border border-border rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 fade-in duration-200"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-desc"
      >
        <div className="p-6 pb-5">
          <div className="flex items-start justify-between gap-4 mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-primary/10 text-primary shrink-0">
                <Sparkles className="w-6 h-6" />
              </div>
              <div>
                <h2 id="onboarding-title" className="font-heading text-xl font-semibold text-foreground tracking-tight">
                  {t('onboarding.welcome')}
                </h2>
                <p id="onboarding-desc" className="text-sm text-muted-foreground mt-0.5">
                  {t('onboarding.stepOf', { current: step + 1, total: STEPS.length })}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleDismiss}
              className="p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0"
              aria-label={t('common.close')}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="rounded-xl border border-border bg-muted/30 p-5 mb-6">
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-xl bg-background border border-border shrink-0">
                <Icon className="w-8 h-8 text-primary" />
              </div>
              <div className="min-w-0">
                <h3 className="font-heading font-semibold text-foreground mb-1">
                  {t(`onboarding.${current.key}Title`)}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {t(`onboarding.${current.key}Desc`)}
                </p>
                <Link
                  href={current.href}
                  onClick={() => handleGoToStep(current.href)}
                  className="inline-flex items-center gap-1.5 mt-3 text-sm font-medium text-primary hover:underline"
                >
                  {t('onboarding.goToStep', { step: t(current.linkLabelKey) })}
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-1">
              {STEPS.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setStep(i)}
                  className={`h-2 rounded-full transition-all ${
                    i === step ? 'w-6 bg-primary' : 'w-2 bg-muted-foreground/30 hover:bg-muted-foreground/50'
                  }`}
                  aria-label={t('onboarding.stepOf', { current: i + 1, total: STEPS.length })}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {step > 0 && (
                <Button variant="outline" size="sm" onClick={() => setStep(step - 1)}>
                  {t('onboarding.previous')}
                </Button>
              )}
              {!isLast ? (
                <Button size="sm" onClick={() => setStep(step + 1)}>
                  {t('onboarding.next')}
                </Button>
              ) : (
                <Button size="sm" onClick={handleGetStarted}>
                  {t('onboarding.getStarted')}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={handleDismiss}>
                {t('onboarding.dismiss')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
