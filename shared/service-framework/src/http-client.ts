import http from 'node:http';
import https from 'node:https';
import { Logger } from '@getsale/logger';
import { Counter, Registry } from 'prom-client';

const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 });

function agentForUrl(url: string) {
  return url.startsWith('https') ? keepAliveHttpsAgent : keepAliveHttpAgent;
}

export interface HttpClientOptions {
  baseUrl: string;
  name: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerResetMs?: number;
  metricsRegistry?: Registry;
}

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
  context?: RequestContext;
}

class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private threshold: number,
    private resetTimeout: number,
  ) {}

  getState() { return this.state; }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) this.state = 'open';
  }

  canExecute(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open' && Date.now() - this.lastFailure > this.resetTimeout) {
      this.state = 'half-open';
      return true;
    }
    return this.state === 'half-open';
  }
}

/**
 * Sliding window retry budget: limits retries to maxRatio of total requests
 * over the last windowMs. Prevents retry storms under sustained failures.
 */
class RetryBudget {
  private total = 0;
  private retries = 0;
  private lastReset = Date.now();

  constructor(
    private windowMs: number = 60_000,
    private maxRatio: number = 0.2,
  ) {}

  recordRequest(): void {
    this.maybeReset();
    this.total++;
  }

  recordRetry(): void {
    this.maybeReset();
    this.retries++;
  }

  canRetry(): boolean {
    this.maybeReset();
    if (this.total < 10) return true;
    return this.retries / this.total < this.maxRatio;
  }

  private maybeReset(): void {
    if (Date.now() - this.lastReset > this.windowMs) {
      this.total = 0;
      this.retries = 0;
      this.lastReset = Date.now();
    }
  }
}

const metricsCache = new WeakMap<Registry, { requests: Counter; circuitRejects: Counter }>();

function getMetrics(registry: Registry) {
  let m = metricsCache.get(registry);
  if (!m) {
    m = {
      requests: new Counter({
        name: 'inter_service_http_requests_total',
        help: 'Outbound ServiceHttpClient calls',
        labelNames: ['client', 'method', 'endpoint', 'outcome'],
        registers: [registry],
      }),
      circuitRejects: new Counter({
        name: 'inter_service_http_circuit_reject_total',
        help: 'Calls rejected while circuit breaker open',
        labelNames: ['client', 'endpoint'],
        registers: [registry],
      }),
    };
    metricsCache.set(registry, m);
  }
  return m;
}

function normalizeEndpoint(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:n')
    .split('?')[0];
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
}

export class ServiceCallError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ServiceCallError';
  }
}

export class ServiceHttpClient {
  private baseUrl: string;
  private defaultTimeout: number;
  private retries: number;
  private retryDelay: number;
  private name: string;
  private log: Logger;
  private internalAuthSecret: string;
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private cbThreshold: number;
  private cbResetMs: number;
  private retryBudget = new RetryBudget();
  private metrics: ReturnType<typeof getMetrics> | null;
  defaultContext?: RequestContext;

  constructor(options: HttpClientOptions, log: Logger) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultTimeout = options.timeoutMs ?? 10_000;
    this.retries = options.retries ?? 2;
    this.retryDelay = options.retryDelayMs ?? 500;
    this.name = options.name;
    this.log = log;
    this.internalAuthSecret = process.env.INTERNAL_AUTH_SECRET?.trim() || '';
    this.cbThreshold = options.circuitBreakerThreshold ?? 5;
    this.cbResetMs = options.circuitBreakerResetMs ?? 30_000;
    this.metrics = options.metricsRegistry ? getMetrics(options.metricsRegistry) : null;
  }

  private getCircuitBreaker(endpoint: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(endpoint);
    if (!cb) {
      cb = new CircuitBreaker(this.cbThreshold, this.cbResetMs);
      this.circuitBreakers.set(endpoint, cb);
    }
    return cb;
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const method = options.method ?? 'GET';
    const timeout = options.timeoutMs ?? this.defaultTimeout;
    const endpoint = normalizeEndpoint(path);
    const cb = this.getCircuitBreaker(endpoint);

    this.retryBudget.recordRequest();

    if (!cb.canExecute()) {
      this.metrics?.circuitRejects.inc({ client: this.name, endpoint });
      throw new ServiceCallError(
        `${this.name} circuit breaker OPEN for ${endpoint}`,
        503,
      );
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        if (!this.retryBudget.canRetry() || !cb.canExecute()) break;
        this.retryBudget.recordRetry();
        const jitter = Math.random() * 0.5 + 0.75;
        const delay = this.retryDelay * Math.pow(2, attempt - 1) * jitter;
        await new Promise((r) => setTimeout(r, delay));
      }

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
        const ctx = options.context ?? this.defaultContext;
        if (ctx) {
          if (ctx.userId) hdrs['x-user-id'] = ctx.userId;
          if (ctx.organizationId) hdrs['x-organization-id'] = ctx.organizationId;
          if (ctx.userRole) hdrs['x-user-role'] = ctx.userRole;
          if (ctx.correlationId) hdrs['x-correlation-id'] = ctx.correlationId;
        }

        const fetchOptions: RequestInit & { dispatcher?: unknown } = {
          method,
          headers: hdrs,
          body: options.body != null ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        };

        const agent = agentForUrl(url);
        (fetchOptions as Record<string, unknown>)['agent'] = agent;

        const res = await fetch(url, fetchOptions);
        clearTimeout(timer);

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          let parsed: unknown;
          try { parsed = JSON.parse(body); } catch { parsed = body; }
          throw new ServiceCallError(`${this.name} ${method} ${path} returned ${res.status}`, res.status, parsed);
        }

        const text = await res.text();
        cb.recordSuccess();
        this.metrics?.requests.inc({ client: this.name, method, endpoint, outcome: 'success' });

        if (res.status === 204 || !text.trim()) return undefined as T;
        try { return JSON.parse(text) as T; } catch { return undefined as T; }
      } catch (err: unknown) {
        clearTimeout(timer);
        lastError = err instanceof Error ? err : new Error(String(err));

        if (err instanceof ServiceCallError && err.statusCode >= 400 && err.statusCode < 500) {
          this.metrics?.requests.inc({ client: this.name, method, endpoint, outcome: 'client_4xx' });
          throw err;
        }

        const skipCircuit =
          (err instanceof ServiceCallError && (err.statusCode === 502 || err.statusCode === 429)) ||
          isAbortError(err);
        if (!skipCircuit) cb.recordFailure();
      }
    }

    const outcome = isAbortError(lastError) ? 'timeout' : 'server_error';
    this.metrics?.requests.inc({ client: this.name, method, endpoint, outcome });

    this.log.error({
      message: `${this.name} ${method} ${path} failed after ${this.retries + 1} attempts`,
      circuit_state: cb.getState(),
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

  async put<T = unknown>(path: string, body: unknown, headers?: Record<string, string>, context?: RequestContext): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body, headers, context });
  }

  async delete<T = unknown>(path: string, headers?: Record<string, string>, context?: RequestContext): Promise<T> {
    return this.request<T>(path, { method: 'DELETE', headers, context });
  }
}

export function interServiceHttpDefaults(): Pick<
  HttpClientOptions,
  'timeoutMs' | 'retries' | 'retryDelayMs' | 'circuitBreakerThreshold' | 'circuitBreakerResetMs'
> {
  const envInt = (name: string, fallback: number) => {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    timeoutMs: envInt('SERVICE_HTTP_TIMEOUT_MS', 10_000),
    retries: envInt('SERVICE_HTTP_RETRIES', 2),
    retryDelayMs: envInt('SERVICE_HTTP_RETRY_DELAY_MS', 500),
    circuitBreakerThreshold: envInt('SERVICE_HTTP_CB_THRESHOLD', 5),
    circuitBreakerResetMs: envInt('SERVICE_HTTP_CB_RESET_MS', 30_000),
  };
}
