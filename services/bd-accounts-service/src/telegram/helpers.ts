// @ts-nocheck — GramJS types are incomplete
import { ProxyConfig } from './types';

export function formatLogArgs(...args: unknown[]): string {
  return args.map(a => {
    if (a instanceof Error) return a.message;
    if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
}

export function buildTelegramProxy(cfg: ProxyConfig | null | undefined): Record<string, unknown> | undefined {
  if (!cfg || !cfg.host || !cfg.port) return undefined;
  return {
    ip: cfg.host,
    port: cfg.port,
    socksType: 5,
    ...(cfg.username ? { username: cfg.username } : {}),
    ...(cfg.password ? { password: cfg.password } : {}),
  };
}

export function reactionsFromTelegramExtra(telegram_extra: Record<string, unknown> | undefined): Record<string, number> | null {
  if (!telegram_extra || typeof telegram_extra !== 'object') return null;
  const raw = telegram_extra.reactions as any;
  if (!raw || typeof raw !== 'object') return null;
  const results = Array.isArray(raw.results) ? raw.results : [];
  const out: Record<string, number> = {};
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    const count = typeof r.count === 'number' ? r.count : 0;
    const reaction = r.reaction;
    const emoji = reaction?.emoticon ?? reaction?.emoji;
    if (typeof emoji === 'string' && emoji.length > 0 && count > 0) {
      out[emoji] = (out[emoji] || 0) + count;
    }
  }
  return Object.keys(out).length ? out : null;
}

export function ourReactionsFromTelegramExtra(telegram_extra: Record<string, unknown> | undefined): string[] | null {
  if (!telegram_extra || typeof telegram_extra !== 'object') return null;
  const raw = telegram_extra.reactions as any;
  if (!raw || typeof raw !== 'object') return null;
  const results = Array.isArray(raw.results) ? raw.results : [];
  const withOrder: { order: number; emoji: string }[] = [];
  for (const r of results) {
    const order = r?.chosen_order ?? r?.chosenOrder;
    if (order == null || typeof order !== 'number') continue;
    const reaction = r.reaction;
    const emoji = reaction?.emoticon ?? reaction?.emoji;
    if (typeof emoji === 'string' && emoji.length > 0) {
      withOrder.push({ order, emoji });
    }
  }
  if (withOrder.length === 0) return null;
  withOrder.sort((a, b) => a.order - b.order);
  return withOrder.map((x) => x.emoji).slice(0, 3);
}
