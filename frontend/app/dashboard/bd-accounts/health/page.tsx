'use client';

import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { AccountHealthDashboard } from '@/components/bd-accounts/AccountHealthDashboard';

export default function BdAccountsHealthPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <Link
          href="/dashboard/bd-accounts"
          className="inline-flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400 hover:text-primary"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('bdAccountHealth.backToAccounts')}
        </Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('bdAccountHealth.pageTitle')}</h1>
      <AccountHealthDashboard />
    </div>
  );
}
