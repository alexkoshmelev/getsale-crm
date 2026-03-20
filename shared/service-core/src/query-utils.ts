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

/**
 * Parse offset from query string with default and min 0.
 */
export function parseOffset(query: Record<string, unknown>, defaultVal: number = 0): number {
  const raw = query.offset;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n < 0) return defaultVal;
  return n;
}

/** Page-based pagination: default limit 20, max 100. Uses shared parseLimit. */
export function parsePageLimit(
  query: Record<string, unknown>,
  defaultLimit = 20,
  maxLimit = 100
): { page: number; limit: number; offset: number } {
  const page = Math.max(1, parseInt(String(query.page), 10) || 1);
  const limit = parseLimit(query, defaultLimit, maxLimit);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

export interface PagedMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Standard list envelope for REST list endpoints. */
export function buildPagedResponse<T>(
  items: T[],
  total: number,
  page: number,
  limit: number
): { items: T[]; pagination: PagedMeta } {
  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 0 },
  };
}
