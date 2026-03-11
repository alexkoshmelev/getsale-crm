import { Logger } from '@getsale/logger';

export interface HttpClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  name: string;
}

/** Optional context to forward to downstream services for attribution and tracing */
export interface RequestContext {
  userId?: string;
  organizationId?: string;
  userRole?: string;
  correlationId?: string;
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** When set, adds X-User-Id, X-Organization-Id, X-User-Role, x-correlation-id to the request */
  context?: RequestContext;
}

export class ServiceHttpClient {
  private baseUrl: string;
  private defaultTimeout: number;
  private retries: number;
  private retryDelay: number;
  private name: string;
  private log: Logger;
  private internalAuthSecret: string;

  constructor(options: HttpClientOptions, log: Logger) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultTimeout = options.timeoutMs ?? 10_000;
    this.retries = options.retries ?? 2;
    this.retryDelay = options.retryDelayMs ?? 500;
    this.name = options.name;
    this.log = log;
    this.internalAuthSecret = process.env.INTERNAL_AUTH_SECRET?.trim() || '';
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const method = options.method ?? 'GET';
    const timeout = options.timeoutMs ?? this.defaultTimeout;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const hdrs: Record<string, string> = {
          'Content-Type': 'application/json',
          ...options.headers,
        };
        if (this.internalAuthSecret && !hdrs['x-internal-auth']) {
          hdrs['x-internal-auth'] = this.internalAuthSecret;
        }
        const ctx = options.context;
        if (ctx) {
          if (ctx.userId) hdrs['x-user-id'] = ctx.userId;
          if (ctx.organizationId) hdrs['x-organization-id'] = ctx.organizationId;
          if (ctx.userRole) hdrs['x-user-role'] = ctx.userRole;
          if (ctx.correlationId) hdrs['x-correlation-id'] = ctx.correlationId;
        }
        const res = await fetch(url, {
          method,
          headers: hdrs,
          body: options.body != null ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          let parsed: unknown;
          try { parsed = JSON.parse(body); } catch { parsed = body; }

          if (res.status >= 400 && res.status < 500) {
            throw new ServiceCallError(
              `${this.name} ${method} ${path} returned ${res.status}`,
              res.status,
              parsed
            );
          }
          throw new ServiceCallError(
            `${this.name} ${method} ${path} returned ${res.status}`,
            res.status,
            parsed
          );
        }

        const data = await res.json() as T;
        return data;
      } catch (err: unknown) {
        clearTimeout(timer);
        lastError = err instanceof Error ? err : new Error(String(err));

        if (err instanceof ServiceCallError && err.statusCode >= 400 && err.statusCode < 500) {
          throw err;
        }

        if (attempt < this.retries) {
          const delay = this.retryDelay * Math.pow(2, attempt);
          this.log.warn({
            message: `${this.name} call failed, retrying`,
            http_method: method,
            http_path: path,
            attempt: attempt + 1,
            delay_ms: delay,
            error: lastError.message,
          });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    this.log.error({
      message: `${this.name} call failed after ${this.retries + 1} attempts`,
      http_method: method,
      http_path: path,
      error: lastError?.message,
    });

    throw lastError;
  }

  async get<T = unknown>(path: string, headers?: Record<string, string>, context?: RequestContext): Promise<T> {
    return this.request<T>(path, { method: 'GET', headers, context });
  }

  async post<T = unknown>(path: string, body: unknown, headers?: Record<string, string>, context?: RequestContext): Promise<T> {
    return this.request<T>(path, { method: 'POST', body, headers, context });
  }

  async patch<T = unknown>(path: string, body: unknown, headers?: Record<string, string>, context?: RequestContext): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body, headers, context });
  }

  async delete<T = unknown>(path: string, headers?: Record<string, string>, context?: RequestContext): Promise<T> {
    return this.request<T>(path, { method: 'DELETE', headers, context });
  }
}

export class ServiceCallError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'ServiceCallError';
  }
}
