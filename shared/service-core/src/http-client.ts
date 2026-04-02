import { Logger } from '@getsale/logger';
import type { Registry } from 'prom-client';
import { Counter } from 'prom-client';

export interface HttpClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  name: string;
  /** Number of consecutive 5xx/timeout failures before the circuit opens (default 5) */
  circuitBreakerThreshold?: number;
  /** Time in ms the circuit stays open before allowing a probe request (default 30 000) */
  circuitBreakerResetMs?: number;
  /** B1: register inter-service call counters on this registry (service /metrics). */
  metricsRegistry?: Registry;
}

const interServiceMetricsCache = new WeakMap<
  Registry,
  { requests: Counter; circuitRejects: Counter }
>();

function getInterServiceMetrics(registry: Registry) {
  let m = interServiceMetricsCache.get(registry);
  if (!m) {
    m = {
      requests: new Counter({
        name: 'inter_service_http_requests_total',
        help: 'Outbound ServiceHttpClient calls (one sample per completed logical request)',
        labelNames: ['client', 'method', 'outcome'],
        registers: [registry],
      }),
      circuitRejects: new Counter({
        name: 'inter_service_http_circuit_reject_total',
        help: 'Calls rejected while circuit breaker open',
        labelNames: ['client'],
        registers: [registry],
      }),
    };
    interServiceMetricsCache.set(registry, m);
  }
  return m;
}

/** Fetch/undici timeout via AbortController — transient; should not trip inter-service circuit breaker. */
function isAbortOrTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  return /abort|aborted/i.test(err.message);
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

class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private threshold: number = 5,
    private resetTimeout: number = 30_000,
  ) {}

  getState(): 'closed' | 'open' | 'half-open' {
    return this.state;
  }

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

export class ServiceHttpClient {
  private baseUrl: string;
  private defaultTimeout: number;
  private retries: number;
  private retryDelay: number;
  private name: string;
  private log: Logger;
  private internalAuthSecret: string;
  private circuitBreaker: CircuitBreaker;
  private interMetrics: ReturnType<typeof getInterServiceMetrics> | null;
  defaultContext?: RequestContext;

  constructor(options: HttpClientOptions, log: Logger) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultTimeout = options.timeoutMs ?? 10_000;
    this.retries = options.retries ?? 2;
    this.retryDelay = options.retryDelayMs ?? 500;
    this.name = options.name;
    this.log = log;
    this.internalAuthSecret = process.env.INTERNAL_AUTH_SECRET?.trim() || '';
    this.circuitBreaker = new CircuitBreaker(
      options.circuitBreakerThreshold ?? 5,
      options.circuitBreakerResetMs ?? 30_000,
    );
    this.interMetrics = options.metricsRegistry ? getInterServiceMetrics(options.metricsRegistry) : null;
  }

  private recordInterRequest(method: string, outcome: string): void {
    this.interMetrics?.requests.inc({ client: this.name, method, outcome });
  }

  /**
   * Create a client pre-bound to the current request's user/org/correlation context.
   * Calls made through the returned client automatically propagate these headers
   * unless overridden per-call.
   */
  static fromRequest(
    req: { user?: { id?: string; organizationId?: string; role?: string }; correlationId?: string },
    options: HttpClientOptions,
    log: Logger,
  ): ServiceHttpClient {
    const client = new ServiceHttpClient(options, log);
    client.defaultContext = {
      userId: req.user?.id,
      organizationId: req.user?.organizationId,
      userRole: req.user?.role,
      correlationId: req.correlationId,
    };
    return client;
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const method = options.method ?? 'GET';
    const timeout = options.timeoutMs ?? this.defaultTimeout;
    const requestStartedAt = Date.now();

    if (!this.circuitBreaker.canExecute()) {
      this.interMetrics?.circuitRejects.inc({ client: this.name });
      this.recordInterRequest(method, 'circuit_open');
      this.log.warn({
        message: `${this.name} circuit breaker OPEN — request rejected`,
        http_method: method,
        http_path: path,
      });
      throw new ServiceCallError(
        `${this.name} circuit breaker is open — ${method} ${path} rejected`,
        503,
      );
    }

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
        const ctx = options.context ?? this.defaultContext;
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

          throw new ServiceCallError(
            `${this.name} ${method} ${path} returned ${res.status}`,
            res.status,
            parsed
          );
        }

        const text = await res.text();
        if (res.status === 204 || text.trim() === '') {
          this.circuitBreaker.recordSuccess();
          this.recordInterRequest(method, 'success');
          return undefined as T;
        }
        let data: T;
        try {
          data = JSON.parse(text) as T;
        } catch {
          this.circuitBreaker.recordSuccess();
          this.recordInterRequest(method, 'success');
          return undefined as T;
        }
        this.circuitBreaker.recordSuccess();
        this.recordInterRequest(method, 'success');
        return data;
      } catch (err: unknown) {
        clearTimeout(timer);
        lastError = err instanceof Error ? err : new Error(String(err));

        if (err instanceof ServiceCallError && err.statusCode >= 400 && err.statusCode < 500) {
          this.recordInterRequest(method, 'client_4xx');
          throw err;
        }

        // Do not count 502 (downstream/Telegram error) or 429 (rate limit) as circuit failure —
        // otherwise FloodWait/PEER_FLOOD from Telegram would open the circuit and block all sends.
        // Do not count client timeouts/aborts — slow downstream under load is not "service dead".
        const skipCircuitFailure =
          (err instanceof ServiceCallError && (err.statusCode === 502 || err.statusCode === 429)) ||
          isAbortOrTimeoutError(err);
        if (!skipCircuitFailure) {
          this.circuitBreaker.recordFailure();
        }

        if (attempt < this.retries) {
          if (!this.circuitBreaker.canExecute()) {
            this.log.warn({
              message: `${this.name} circuit breaker tripped during retries — aborting`,
              http_method: method,
              http_path: path,
            });
            break;
          }
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

    const elapsedMs = Date.now() - requestStartedAt;
    this.log.error({
      message: `${this.name} call failed after ${this.retries + 1} attempts`,
      http_method: method,
      http_path: path,
      circuit_state: this.circuitBreaker.getState(),
      error: lastError?.message,
      timeout_ms: timeout,
      elapsed_ms: elapsedMs,
      ...(lastError && isAbortOrTimeoutError(lastError) ? { abort_or_timeout: true as const } : {}),
    });

    // #region agent log
    if (lastError && isAbortOrTimeoutError(lastError)) {
      fetch('http://127.0.0.1:7616/ingest/8e0fed1a-599a-4090-870e-153a68699529', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'cfe557' },
        body: JSON.stringify({
          sessionId: 'cfe557',
          location: 'http-client.ts:request',
          message: 'ServiceHttpClient aborted',
          data: {
            hypothesisId: 'H-timeout',
            name: this.name,
            http_method: method,
            http_path: path,
            timeout_ms: timeout,
            elapsed_ms: elapsedMs,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
    }
    // #endregion

    this.recordInterRequest(method, classifyInterServiceOutcome(lastError));
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

function classifyInterServiceOutcome(err: unknown): string {
  if (err instanceof ServiceCallError) {
    if (err.statusCode >= 400 && err.statusCode < 500) return 'client_4xx';
    return 'server_or_downstream';
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(msg) || (err as Error)?.name === 'AbortError') return 'timeout_abort';
  return 'network_error';
}
