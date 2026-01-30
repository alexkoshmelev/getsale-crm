/**
 * Known console noise (not from this app):
 * - "A listener indicated an asynchronous response... message channel closed"
 *   → Comes from a Chrome extension (e.g. password manager, ad blocker). Safe to ignore.
 */
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin', 'cyrillic'] });

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
    <html lang="ru">
      <body className={inter.className}>{children}</body>
    </html>
  );
}

