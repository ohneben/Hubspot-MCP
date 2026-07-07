import { describe, it, expect } from "vitest";
import { RateLimiter } from "../src/rateLimiter.js";

describe("RateLimiter", () => {
  it("allows up to maxRequests immediately, then throttles", async () => {
    const limiter = new RateLimiter(4, 1000);
    const start = Date.now();
    // 4 slots should be granted without waiting for the window.
    for (let i = 0; i < 4; i++) await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(200);

    // The 5th must wait for the window to roll (~1000ms).
    await limiter.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  });

  it("makes the next batch wait a full window before it can proceed", async () => {
    // 3 requests / 300ms window, fired 6-up concurrently. The limiter's sleep
    // enforces a hard gap, so we assert on lower/upper bounds it *guarantees*
    // (robust on a loaded CI runner) rather than counting timestamps in an
    // arbitrary window (which jitter can make flaky).
    const limiter = new RateLimiter(3, 300);
    const start = Date.now();
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        await limiter.acquire();
        done.push(Date.now() - start);
      }),
    );

    // At most `maxRequests` can complete inside the first window; the limiter
    // sleeps ~one window before releasing the rest, so nothing else finishes early.
    const early = done.filter((t) => t < 150).length;
    expect(early).toBeLessThanOrEqual(3);

    // The remaining requests were held until the window rolled (~300ms).
    expect(Math.max(...done)).toBeGreaterThanOrEqual(250);
  });
});
