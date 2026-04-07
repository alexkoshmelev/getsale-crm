/**
 * ЭТАП 5 — Observability: единый контракт логирования.
 * Один формат JSON во всех сервисах; дисциплина через API, не через привычку.
 */

export interface LogPayload {
  message: string;
  correlation_id?: string;
  event_id?: string;
  entity_type?: string;
  entity_id?: string;
  rule_id?: string;
  status?: 'success' | 'skipped' | 'failed';
  [key: string]: unknown;
}

function formatLine(service: string, level: string, payload: LogPayload): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    service,
    level,
    ...payload,
  });
}

export function createLogger(service: string) {
  return {
    info(payload: LogPayload): void {
      process.stdout.write(formatLine(service, 'info', payload) + '\n');
    },
    warn(payload: LogPayload): void {
      process.stdout.write(formatLine(service, 'warn', payload) + '\n');
    },
    error(payload: LogPayload): void {
      process.stderr.write(formatLine(service, 'error', payload) + '\n');
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
