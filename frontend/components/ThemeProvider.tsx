'use client';

import { useEffect, useState } from 'react';
import { useThemeStore } from '@/lib/stores/theme-store';

export default function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const mode = useThemeStore((s) => s.mode);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    const apply = (dark: boolean) => {
      root.classList.remove('light', 'dark');
      root.classList.add(dark ? 'dark' : 'light');
    };
    if (mode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      apply(mq.matches);
      const handler = () => apply(mq.matches);
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    apply(mode === 'dark');
  }, [mode, mounted]);

  return <>{children}</>;
}
