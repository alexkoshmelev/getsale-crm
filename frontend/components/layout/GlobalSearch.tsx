'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Link from 'next/link';
import { Search, Building2, User, TrendingUp, ArrowRight, Loader2, MessageSquare, Send } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import { fetchCompanies, fetchContacts, fetchDeals, type Company, type Contact, type Deal } from '@/lib/api/crm';
import { searchChats, type MessagingChatSearchItem } from '@/lib/api/messaging';

const QUICK_LINKS = [
  { href: '/dashboard/crm', key: 'crm', icon: Building2 },
  { href: '/dashboard/pipeline', key: 'pipeline', icon: TrendingUp },
  { href: '/dashboard/campaigns', key: 'campaigns', icon: Send },
  { href: '/dashboard/messaging', key: 'messaging', icon: User },
];

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;
const SEARCH_LIMIT = 5;

function getContactDisplayName(c: Contact): string {
  const dn = (c.display_name ?? '').trim();
  if (dn) return dn;
  const fn = (c.first_name ?? '').trim();
  const ln = (c.last_name ?? '').trim();
  const full = [fn, ln].filter(Boolean).join(' ').trim();
  if (full && !/^Telegram\s+\d+$/i.test(full)) return full;
  const un = (c.username ?? '').trim();
  if (un) return un.startsWith('@') ? un : `@${un}`;
  if (c.telegram_id) return String(c.telegram_id);
  return '—';
}

export function GlobalSearch() {
  const { t } = useTranslation();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{
    companies: Company[];
    contacts: Contact[];
    deals: Deal[];
    chats: MessagingChatSearchItem[];
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const runSearch = useCallback(async (q: string) => {
    if (q.length < MIN_QUERY_LENGTH) {
      setResults(null);
      return;
    }
    setLoading(true);
    setResults(null);
    try {
      const [companiesRes, contactsRes, dealsRes, chatsRes] = await Promise.all([
        fetchCompanies({ search: q, limit: SEARCH_LIMIT, page: 1 }),
        fetchContacts({ search: q, limit: SEARCH_LIMIT, page: 1 }),
        fetchDeals({ search: q, limit: SEARCH_LIMIT, page: 1 }),
        searchChats(q, SEARCH_LIMIT),
      ]);
      setResults({
        companies: companiesRes.items,
        contacts: contactsRes.items,
        deals: dealsRes.items,
        chats: chatsRes.items,
      });
    } catch {
      setResults({ companies: [], contacts: [], deals: [], chats: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debouncedQuery.length >= MIN_QUERY_LENGTH) runSearch(debouncedQuery);
    else setResults(null);
  }, [debouncedQuery, runSearch]);

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

  const goToCrmOpen = (tab: 'companies' | 'contacts' | 'deals', id: string) => {
    setOpen(false);
    setQuery('');
    setResults(null);
    router.push(`/dashboard/crm?tab=${tab}&open=${encodeURIComponent(id)}`);
  };

  const goToMessagingChat = (bdAccountId: string, channelId: string) => {
    setOpen(false);
    setQuery('');
    setResults(null);
    router.push(`/dashboard/messaging?bdAccountId=${encodeURIComponent(bdAccountId)}&open=${encodeURIComponent(channelId)}`);
  };

  const placeholder = t('global.searchPlaceholder');
  const showSearch = query.trim().length >= MIN_QUERY_LENGTH;
  const hasResults =
    results &&
    (results.companies.length > 0 || results.contacts.length > 0 || results.deals.length > 0 || results.chats.length > 0);

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
        <div className="absolute top-full left-0 right-0 mt-1 rounded-xl border border-border bg-card shadow-soft-lg overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-150 min-w-[320px]">
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
          <div className="p-2 max-h-[320px] overflow-y-auto">
            {showSearch ? (
              <>
                {loading ? (
                  <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="text-sm">{t('common.loading')}</span>
                  </div>
                ) : hasResults ? (
                  <div className="space-y-3">
                    {results!.companies.length > 0 && (
                      <div>
                        <p className="px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {t('crm.companies')}
                        </p>
                        <div className="space-y-0.5">
                          {results!.companies.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => goToCrmOpen('companies', c.id)}
                              className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-accent transition-colors text-left"
                            >
                              <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                              <span className="text-sm font-medium text-foreground truncate">{c.name}</span>
                              <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0 ml-auto" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {results!.contacts.length > 0 && (
                      <div>
                        <p className="px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {t('crm.contacts')}
                        </p>
                        <div className="space-y-0.5">
                          {results!.contacts.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => goToCrmOpen('contacts', c.id)}
                              className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-accent transition-colors text-left"
                            >
                              <User className="w-4 h-4 text-muted-foreground shrink-0" />
                              <span className="text-sm font-medium text-foreground truncate">{getContactDisplayName(c)}</span>
                              <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0 ml-auto" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {results!.deals.length > 0 && (
                      <div>
                        <p className="px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {t('crm.deals')}
                        </p>
                        <div className="space-y-0.5">
                          {results!.deals.map((d) => (
                            <button
                              key={d.id}
                              type="button"
                              onClick={() => goToCrmOpen('deals', d.id)}
                              className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-accent transition-colors text-left"
                            >
                              <TrendingUp className="w-4 h-4 text-muted-foreground shrink-0" />
                              <span className="text-sm font-medium text-foreground truncate">{d.title}</span>
                              <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0 ml-auto" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {results!.chats.length > 0 && (
                      <div>
                        <p className="px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {t('messaging.chatsSection')}
                        </p>
                        <div className="space-y-0.5">
                          {results!.chats.map((chat) => (
                            <button
                              key={`${chat.bd_account_id}-${chat.channel_id}`}
                              type="button"
                              onClick={() => goToMessagingChat(chat.bd_account_id, chat.channel_id)}
                              className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-accent transition-colors text-left"
                            >
                              <MessageSquare className="w-4 h-4 text-muted-foreground shrink-0" />
                              <span className="text-sm font-medium text-foreground truncate">{chat.name || chat.channel_id}</span>
                              <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0 ml-auto" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    {t('global.searchNoResults')}
                  </div>
                )}
              </>
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
