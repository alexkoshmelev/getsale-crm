/**
 * Known console noise (not from this app):
 * - "A listener indicated an asynchronous response... message channel closed"
 *   → Comes from a Chrome extension (e.g. password manager, ad blocker). Safe to ignore.
 */
import type { Metadata } from 'next';
import { Inter, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import ClientProviders from '@/components/ClientProviders';

const inter = Inter({ subsets: ['latin', 'cyrillic'], variable: '--font-sans' });
const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin', 'cyrillic-ext'],
  variable: '--font-heading',
});

export const metadata: Metadata = {
  title: 'GetSale CRM - AI-Powered Sales Platform',
  description: 'Enterprise CRM with AI assistance, messaging, and automation',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
(function() {
  try {
    var stored = localStorage.getItem('getsale-theme');
    var parsed = stored ? JSON.parse(stored) : null;
    var mode = (parsed && parsed.state && parsed.state.mode !== undefined) ? parsed.state.mode : (parsed && parsed.mode !== undefined) ? parsed.mode : 'system';
    var dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(dark ? 'dark' : 'light');
  } catch (e) {}
})();
            `,
          }}
        />
      </head>
      <body className={`${inter.variable} ${plusJakarta.variable} font-sans antialiased`}>
        <ClientProviders>{children}</ClientProviders>
      </body>
    </html>
  );
}

