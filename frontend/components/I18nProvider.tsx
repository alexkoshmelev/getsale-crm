'use client';

import { useEffect } from 'react';
import { useLocaleStore } from '@/lib/stores/locale-store';
import i18n from '@/lib/i18n';

export default function I18nProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = useLocaleStore((s) => s.locale);

  useEffect(() => {
    if (i18n.language !== locale) {
      i18n.changeLanguage(locale);
    }
  }, [locale]);

  return <>{children}</>;
}
