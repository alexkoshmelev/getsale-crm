'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle, BookOpen, Mail } from 'lucide-react';
import { clsx } from 'clsx';

export function HelpDropdown() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={t('nav.help')}
      >
        <HelpCircle className="w-5 h-5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 rounded-xl border border-border bg-card shadow-soft-lg overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="p-2">
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent transition-colors text-sm text-foreground"
            >
              <BookOpen className="w-4 h-4 text-muted-foreground shrink-0" />
              {t('global.helpDocs')}
            </a>
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent transition-colors text-sm text-foreground"
            >
              <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
              {t('global.helpSupport')}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
