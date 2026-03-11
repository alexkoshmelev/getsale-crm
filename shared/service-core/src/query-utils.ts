/**
 * Parse limit from query string with default and max cap.
 * Use for pagination and list endpoints to avoid inconsistent parsing across services.
 */
export function parseLimit(
  query: Record<string, unknown>,
  defaultVal: number,
  max: number
): number {
  const raw = query.limit;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(n, max);
}
