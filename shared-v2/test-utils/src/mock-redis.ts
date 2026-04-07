import { vi } from 'vitest';

export interface MockRedis {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
  checkRateLimit: ReturnType<typeof vi.fn>;
  getStorage: () => Map<string, string>;
  clearStorage: () => void;
}

export function createMockRedis(): MockRedis {
  const storage = new Map<string, string>();

  const get = vi.fn(async (key: string): Promise<string | null> => {
    return storage.get(key) ?? null;
  });

  const set = vi.fn(async (key: string, value: string): Promise<void> => {
    storage.set(key, value);
  });

  const del = vi.fn(async (key: string): Promise<void> => {
    storage.delete(key);
  });

  const incr = vi.fn().mockResolvedValue(1);

  const checkRateLimit = vi.fn().mockResolvedValue(true);

  return {
    get,
    set,
    del,
    incr,
    checkRateLimit,
    getStorage: () => storage,
    clearStorage: () => storage.clear(),
  };
}
