import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";

/** Spacing limiter. `perSecond` requests are spread across the second. */
export class RateLimiter {
  private nextAt = 0;

  constructor(
    private readonly perSecond: number,
    private readonly clock: Clock = systemClock,
  ) {}

  async take(): Promise<void> {
    const interval = Math.ceil(1000 / this.perSecond);
    const now = this.clock.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + interval;
    const wait = at - now;
    if (wait > 0) await this.clock.sleep(wait);
  }
}
