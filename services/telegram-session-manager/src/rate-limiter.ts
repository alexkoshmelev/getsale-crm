/**
 * Per-account token bucket rate limiter with flood wait integration.
 * Each account has its own rate limiter. When a flood wait is received,
 * the limiter blocks all commands for that duration.
 */
export class AccountRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private floodUntil: number = 0;

  constructor(
    private maxTokens: number = 3,
    private refillIntervalMs: number = 60_000,
    private refillAmount: number = 3,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refills = Math.floor(elapsed / this.refillIntervalMs);
    if (refills > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + refills * this.refillAmount);
      this.lastRefill = now;
    }
  }

  canConsume(): boolean {
    if (Date.now() < this.floodUntil) return false;
    this.refill();
    return this.tokens > 0;
  }

  consume(): boolean {
    if (!this.canConsume()) return false;
    this.tokens--;
    return true;
  }

  /**
   * Time in ms until next token is available.
   * Returns 0 if a token is available now.
   */
  timeUntilAvailable(): number {
    const now = Date.now();
    if (now < this.floodUntil) return this.floodUntil - now;
    this.refill();
    if (this.tokens > 0) return 0;
    return this.refillIntervalMs - (now - this.lastRefill);
  }

  /**
   * Called when GramJS returns FloodWaitError.
   * Pauses all operations for the specified duration.
   */
  applyFloodWait(seconds: number): void {
    this.floodUntil = Date.now() + seconds * 1000;
    this.tokens = 0;
  }

  isFlooded(): boolean {
    return Date.now() < this.floodUntil;
  }

  getFloodWaitRemaining(): number {
    const remaining = this.floodUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }
}
