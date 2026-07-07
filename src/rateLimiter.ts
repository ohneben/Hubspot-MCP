/**
 * A tiny sliding-window rate limiter.
 *
 * HubSpot enforces burst limits per 10-second window (private apps: 100/10s on
 * Free/Starter, 150/10s on Professional/Enterprise; OAuth apps: ~110/10s) plus
 * a separate cap of ~5 requests/second on the CRM search endpoints. The server
 * self-throttles a little below those ceilings so a burst of tool calls never
 * trips the server-side limit in the first place — the 429 retries in
 * client.ts are only a backstop.
 *
 * JavaScript's single thread makes the "check length, then record" step atomic
 * (there is no `await` between them), so concurrent callers can never
 * over-fill the window.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly timestamps: number[] = [];

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = Math.max(1, Math.floor(maxRequests));
    this.windowMs = Math.max(1, Math.floor(windowMs));
  }

  /** Resolves as soon as a request slot is free, recording the request. */
  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const windowStart = now - this.windowMs;

      while (this.timestamps.length > 0 && this.timestamps[0] <= windowStart) {
        this.timestamps.shift();
      }

      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }

      const waitMs = this.timestamps[0] - windowStart;
      await sleep(Math.max(waitMs, 1));
    }
  }
}
