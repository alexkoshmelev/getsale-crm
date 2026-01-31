'use client';

import '@/lib/i18n';
import ThemeProvider from '@/components/ThemeProvider';
import I18nProvider from '@/components/I18nProvider';
import { ToastProvider } from '@/lib/contexts/toast-context';
import { ToastContainer } from '@/components/ui/Toast';

export default function ClientProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          {children}
          <ToastContainer />
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
