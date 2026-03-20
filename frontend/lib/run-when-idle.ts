/**
 * Runs `fn` after the browser is idle, or after `timeout` ms (whichever first).
 * Use to defer non-critical work so the current route’s data loads first.
 */
export function runWhenIdle(fn: () => void, timeout = 2500): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  if (typeof requestIdleCallback !== 'undefined') {
    const id = requestIdleCallback(fn, { timeout });
    return () => cancelIdleCallback(id);
  }
  const t = window.setTimeout(fn, Math.min(timeout, 800));
  return () => clearTimeout(t);
}
