/**
 * Символ валюты по коду. По умолчанию USD → $.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  RUB: '₽',
  EUR: '€',
  GBP: '£',
  KZT: '₸',
  UAH: '₴',
  CNY: '¥',
  JPY: '¥',
  CHF: 'Fr',
};

const DEFAULT_SYMBOL = '$';

/**
 * Возвращает символ валюты для отображения. Для неизвестного кода возвращает сам код или $.
 */
export function getCurrencySymbol(currencyCode: string | null | undefined): string {
  if (currencyCode == null || currencyCode === '') return DEFAULT_SYMBOL;
  const code = currencyCode.trim().toUpperCase();
  if (!code) return DEFAULT_SYMBOL;
  return CURRENCY_SYMBOLS[code] ?? code;
}

/**
 * Форматирует сумму сделки: целое число + символ валюты (например "5000 $").
 */
export function formatDealAmount(value: number | null | undefined, currency?: string | null): string {
  if (value == null) return '';
  const n = Number(value);
  if (Number.isNaN(n)) return '';
  const rounded = Math.round(n);
  const symbol = getCurrencySymbol(currency ?? 'USD');
  return `${rounded} ${symbol}`;
}
