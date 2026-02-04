'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';

const PATH_LABELS: Record<string, string> = {
  dashboard: 'nav.home',
  crm: 'nav.crm',
  pipeline: 'nav.pipeline',
  messaging: 'nav.messaging',
  'bd-accounts': 'nav.bdAccounts',
  analytics: 'nav.analytics',
  team: 'nav.team',
  settings: 'nav.settings',
};

export function Breadcrumbs() {
  const pathname = usePathname();
  const { t } = useTranslation();

  const segments = pathname.split('/').filter(Boolean);
  if (segments.length <= 1) return null;

  const crumbs = segments.map((segment, i) => {
    const href = '/' + segments.slice(0, i + 1).join('/');
    const labelKey = PATH_LABELS[segment];
    const label = labelKey ? t(labelKey) : segment;
    const isLast = i === segments.length - 1;
    return { href, label, isLast };
  });

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
      {crumbs.map((crumb, i) => (
        <span key={crumb.href} className="flex items-center gap-1.5">
          {i > 0 && <ChevronRight className="w-4 h-4 text-muted-foreground/70" />}
          {crumb.isLast ? (
            <span className="font-medium text-foreground truncate max-w-[140px] sm:max-w-none" aria-current="page">
              {crumb.label}
            </span>
          ) : (
            <Link
              href={crumb.href}
              className="hover:text-foreground transition-colors truncate max-w-[100px] sm:max-w-none"
            >
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
