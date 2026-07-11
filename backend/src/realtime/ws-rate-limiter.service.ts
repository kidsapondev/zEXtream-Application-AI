import { Injectable } from '@nestjs/common';

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Per-socket fixed-window rate limiter for WebSocket events. NestJS's
 * ThrottlerGuard never reaches @SubscribeMessage handlers — SocketModule
 * builds its guards/pipes context without the app's ApplicationConfig, so
 * global APP_GUARD providers silently never run for gateways (see
 * ws-validation.filter.ts for the same finding applied to pipes) — so
 * gateway-level rate limiting has to be done by hand instead of reusing the
 * REST-side @Throttle() decorators.
 */
@Injectable()
export class WsRateLimiterService {
  private readonly buckets = new Map<string, Bucket>();

  /** Returns true if the call is allowed, false if the caller is over the limit. */
  allow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (bucket.count >= limit) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  /** Drops all bucket state for a socket so disconnected clients don't accumulate forever. */
  release(socketId: string): void {
    const prefix = `${socketId}:`;
    for (const key of this.buckets.keys()) {
      if (key.startsWith(prefix)) {
        this.buckets.delete(key);
      }
    }
  }

  /** Clears every bucket. Mainly useful for test isolation between cases sharing an instance. */
  reset(): void {
    this.buckets.clear();
  }
}
