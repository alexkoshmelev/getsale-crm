'use client';

import { ReactNode, useState, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useLayoutStore } from '@/lib/stores/layout-store';
import { useThemeStore, type ThemeMode } from '@/lib/stores/theme-store';
import { useLocaleStore } from '@/lib/stores/locale-store';
import type { Locale } from '@/lib/i18n';
import Link from 'next/link';
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  BarChart3,
  Settings,
  LogOut,
  Building2,
  Workflow,
  Smartphone,
  PanelLeftClose,
  PanelLeft,
  Sun,
  Moon,
  Monitor,
  Keyboard,
} from 'lucide-react';
import { clsx } from 'clsx';
import { GlobalSearch } from '@/components/layout/GlobalSearch';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { NotificationsDropdown } from '@/components/layout/NotificationsDropdown';
import { KeyboardShortcutsModal } from '@/components/layout/KeyboardShortcutsModal';
import { HelpDropdown } from '@/components/layout/HelpDropdown';

interface DashboardLayoutProps {
  children: ReactNode;
}

const productItems: { href: string; i18nKey: string; icon: typeof LayoutDashboard }[] = [
  { href: '/dashboard/messaging', i18nKey: 'messaging', icon: MessageSquare },
  { href: '/dashboard', i18nKey: 'home', icon: LayoutDashboard },
  { href: '/dashboard/crm', i18nKey: 'crm', icon: Building2 },
  { href: '/dashboard/pipeline', i18nKey: 'pipeline', icon: Workflow },
  { href: '/dashboard/bd-accounts', i18nKey: 'bdAccounts', icon: Smartphone },
  { href: '/dashboard/analytics', i18nKey: 'analytics', icon: BarChart3 },
  { href: '/dashboard/team', i18nKey: 'team', icon: Users },
];
const accountItems: { href: string; i18nKey: string; icon: typeof Settings }[] = [
  { href: '/dashboard/settings', i18nKey: 'settings', icon: Settings },
];

const themeOptions: { value: ThemeMode; i18nKey: string; icon: typeof Sun }[] = [
  { value: 'light', i18nKey: 'light', icon: Sun },
  { value: 'dark', i18nKey: 'dark', icon: Moon },
  { value: 'system', i18nKey: 'system', icon: Monitor },
];

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { user, logout } = useAuthStore();
  const { sidebarCollapsed, toggleSidebar } = useLayoutStore();
  const { mode: themeMode, setMode: setThemeMode } = useThemeStore();
  const { locale, setLocale } = useLocaleStore();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        e.preventDefault();
        setShortcutsOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleLogout = () => {
    logout();
    router.push('/auth/login');
  };

  const sidebarWidth = sidebarCollapsed ? 'w-16' : 'w-64';
  const mainMargin = sidebarCollapsed ? 'ml-16' : 'ml-64';
  const allItems = [...productItems, ...accountItems];
  const currentItem = allItems.find((m) => m.href === pathname);
  const pageTitle = currentItem ? t(`nav.${currentItem.i18nKey}`) : t('dashboard.title');

  return (
    <div className="min-h-screen bg-background transition-colors">
      {/* Sidebar */}
      <aside
        className={clsx(
          'fixed left-0 top-0 z-40 h-full bg-card border-r border-border flex flex-col transition-[width] duration-200 ease-in-out',
          sidebarWidth
        )}
      >
        {/* Logo / Toggle — h-14 to align with header */}
        <div className="shrink-0 flex items-center h-14 min-h-[3.5rem] border-b border-border px-3">
          {sidebarCollapsed ? (
            <button
              type="button"
              onClick={toggleSidebar}
              className="w-10 h-10 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-accent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              title={t('nav.expandMenu')}
            >
              <PanelLeft className="w-5 h-5" />
            </button>
          ) : (
            <>
              <span className="font-heading text-lg font-bold text-foreground truncate flex-1 tracking-tight">
                GetSale
              </span>
              <button
                type="button"
                onClick={toggleSidebar}
                className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-accent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                title={t('nav.collapseMenu')}
              >
                <PanelLeftClose className="w-5 h-5" />
              </button>
            </>
          )}
        </div>

        {/* Nav — Product */}
        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
          {!sidebarCollapsed && (
            <p className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('nav.product')}
            </p>
          )}
          {productItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;
            const label = t(`nav.${item.i18nKey}`);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={sidebarCollapsed ? label : undefined}
                className={clsx(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  sidebarCollapsed && 'justify-center px-2',
                  isActive
                    ? 'bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary'
                    : 'text-foreground hover:bg-accent',
                  isActive && !sidebarCollapsed && 'border-l-2 border-l-primary -ml-0.5 pl-3.5'
                )}
              >
                <Icon className="w-5 h-5 shrink-0" />
                {!sidebarCollapsed && <span>{label}</span>}
              </Link>
            );
          })}
          {!sidebarCollapsed && (
            <p className="px-3 mt-4 mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('nav.account')}
            </p>
          )}
          {accountItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;
            const label = t(`nav.${item.i18nKey}`);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={sidebarCollapsed ? label : undefined}
                className={clsx(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  sidebarCollapsed && 'justify-center px-2',
                  isActive
                    ? 'bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary'
                    : 'text-foreground hover:bg-accent',
                  isActive && !sidebarCollapsed && 'border-l-2 border-l-primary -ml-0.5 pl-3.5'
                )}
              >
                <Icon className="w-5 h-5 shrink-0" />
                {!sidebarCollapsed && <span>{label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* User + Logout only */}
        <div className="shrink-0 border-t border-border p-2 space-y-1">
          {!sidebarCollapsed && (
            <div className="px-3 py-2">
              <p className="text-sm font-medium text-foreground truncate">
                {user?.email}
              </p>
              <p className="text-xs text-muted-foreground">
                {user?.role}
              </p>
            </div>
          )}

          <button
            onClick={handleLogout}
            title={sidebarCollapsed ? t('nav.logout') : undefined}
            className={clsx(
              'w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors',
              sidebarCollapsed && 'justify-center px-2'
            )}
          >
            <LogOut className="w-5 h-5 shrink-0" />
            {!sidebarCollapsed && <span>{t('nav.logout')}</span>}
          </button>
        </div>
      </aside>

      {/* Main Content — на messaging фиксируем высоту (h-screen), чтобы не было общего скролла страницы */}
      <div
        className={clsx(
          'flex flex-col transition-[margin] duration-200 ease-in-out',
          mainMargin,
          pathname === '/dashboard/messaging' ? 'h-screen overflow-hidden' : 'min-h-screen'
        )}
      >
        <header className="shrink-0 z-10 bg-card/95 backdrop-blur-sm border-b border-border h-14 min-h-[3.5rem] px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 shadow-soft">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <GlobalSearch />
            <div className="hidden sm:block flex-1 min-w-0">
              <Breadcrumbs />
            </div>
            <div className="sm:hidden flex-1 min-w-0">
              <h2 className="font-heading text-lg font-semibold text-foreground truncate tracking-tight">
                {pageTitle}
              </h2>
            </div>
          </div>

          {/* Notifications, Help, Shortcuts, Theme, Language */}
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            <NotificationsDropdown />
            <HelpDropdown />
            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              className="p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              title={t('nav.keyboardShortcuts')}
            >
              <Keyboard className="w-5 h-5" />
            </button>
            {/* Theme switcher */}
            <div className="flex items-center gap-0.5 rounded-lg p-0.5 bg-muted/50">
              {themeOptions.map((opt) => {
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    title={t(`theme.${opt.i18nKey}`)}
                    onClick={() => setThemeMode(opt.value)}
                    className={clsx(
                      'p-2 rounded-md transition-colors',
                      themeMode === opt.value
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <Icon className="w-4 h-4" />
                  </button>
                );
              })}
            </div>

            {/* Language switcher */}
            <div className="flex items-center gap-0.5 rounded-lg p-0.5 bg-muted/50">
              {(['en', 'ru'] as Locale[]).map((loc) => (
                <button
                  key={loc}
                  type="button"
                  title={t(`locale.${loc}`)}
                  onClick={() => setLocale(loc)}
                  className={clsx(
                    'px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors',
                    locale === loc
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  {loc.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </header>

        <main
          className={clsx(
            'flex-1 min-h-0 flex flex-col animate-in fade-in duration-200',
            pathname === '/dashboard/messaging' ? 'p-0 overflow-hidden' : 'p-4 sm:p-6 overflow-auto'
          )}
        >
          <div className="sm:hidden mb-2 shrink-0"><Breadcrumbs /></div>
          <div
            className={clsx(
              'min-w-0',
              pathname === '/dashboard/messaging'
                ? 'flex-1 min-h-0 flex flex-col overflow-hidden'
                : 'flex-1 min-h-0 overflow-auto'
            )}
          >
            {children}
          </div>
        </main>
      </div>
      <KeyboardShortcutsModal isOpen={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
