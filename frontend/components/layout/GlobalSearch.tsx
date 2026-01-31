'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { Search, Building2, User, TrendingUp, ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';

const QUICK_LINKS = [
  { href: '/dashboard/crm', key: 'crm', icon: Building2 },
  { href: '/dashboard/pipeline', key: 'pipeline', icon: TrendingUp },
  { href: '/dashboard/messaging', key: 'messaging', icon: User },
];

export function GlobalSearch() {
  const { t } = useTranslation();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  const placeholder = t('global.searchPlaceholder');

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 50); }}
        className={clsx(
          'flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors text-sm w-full sm:w-64 max-w-[240px]',
          open && 'ring-2 ring-ring ring-offset-2 ring-offset-background border-transparent'
        )}
      >
        <Search className="w-4 h-4 shrink-0" />
        <span className="hidden sm:inline truncate">{placeholder}</span>
        <kbd className="hidden sm:inline ml-auto text-xs bg-muted px-1.5 py-0.5 rounded">⌘K</kbd>
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 rounded-xl border border-border bg-card shadow-soft-lg overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="p-2 border-b border-border">
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-muted/30">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={placeholder}
                className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
                autoComplete="off"
              />
            </div>
          </div>
          <div className="p-2 max-h-[280px] overflow-y-auto">
            {query.trim().length > 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                {t('global.searchNoResults')}
                <p className="text-xs mt-1">Full search will be available with backend.</p>
              </div>
            ) : (
              <>
                <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('global.searchRecent')}
                </p>
                <div className="space-y-0.5">
                  {QUICK_LINKS.map((link) => {
                    const Icon = link.icon;
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        onClick={() => setOpen(false)}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent transition-colors text-left"
                      >
                        <Icon className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm font-medium text-foreground">{t(`nav.${link.key}`)}</span>
                        <ArrowRight className="w-4 h-4 text-muted-foreground ml-auto" />
                      </Link>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
