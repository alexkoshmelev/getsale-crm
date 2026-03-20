/** Shared ETA/speed hints for parse SSE (DB poll + Redis payloads). */

export function computeParseEtaFields(input: {
  parseStartedAtMs?: number;
  /** Chats already fully processed (task.progress at tick time). */
  chatsCompleted: number;
  totalChats: number;
  found: number;
}): { etaSeconds?: number; speed?: number } {
  const started = input.parseStartedAtMs;
  if (typeof started !== 'number' || started <= 0) return {};
  const elapsedSec = (Date.now() - started) / 1000;
  if (elapsedSec < 2) return {};

  const speed = input.found > 0 ? Math.round((input.found / elapsedSec) * 10) / 10 : undefined;

  let etaSeconds: number | undefined;
  const { chatsCompleted, totalChats } = input;
  if (chatsCompleted >= 1 && totalChats > chatsCompleted && elapsedSec >= 2) {
    const rate = chatsCompleted / elapsedSec;
    if (rate > 0) etaSeconds = Math.round((totalChats - chatsCompleted) / rate);
  }
  const out: { etaSeconds?: number; speed?: number } = {};
  if (etaSeconds != null && etaSeconds >= 0 && etaSeconds < 86400) out.etaSeconds = etaSeconds;
  if (speed != null && speed > 0) out.speed = speed;
  return out;
}
