/**
 * Token-bucket rate limiting.
 *
 * Two independent buckets guard the API:
 * - the **auth tier** — one token per request on every rate-limited /v1
 *   route, keyed by client IP (absorbs token-guessing floods);
 * - the **publish tier** — an extra token per publish request, keyed by
 *   `<principal>|<ip>` (a compromised credential cannot exhaust publishing
 *   for other principals from the same IP).
 *
 * Buckets refill continuously (`refillPerSecond` tokens per second up to
 * `capacity`). When a bucket is empty the caller receives 429 with a
 * `Retry-After` header of the whole seconds until one token is available.
 *
 * The clock is injectable (`now`) so tests can drive refills deterministically.
 * Stale buckets (idle for over an hour) are swept lazily to bound memory.
 */

import type { RateLimitConfig, RateLimitOptions } from './types';

export interface RateLimitDecision {
  ok: boolean;
  /** Seconds until one token is available (whole seconds, ≥ 1) when !ok. */
  retryAfterSeconds: number;
  /** Configured capacity of the bucket (for RateLimit-* headers). */
  limit: number;
  /** Tokens remaining after the decision (floor, ≥ 0). */
  remaining: number;
}

export type RateLimitTier = 'auth' | 'publish';

const DEFAULTS: Readonly<Record<RateLimitTier, RateLimitConfig>> = {
  auth: { capacity: 120, refillPerSecond: 30 },
  publish: { capacity: 30, refillPerSecond: 5 },
};

/** Buckets idle for longer than this are dropped by the sweep. */
const SWEEP_IDLE_MS = 60 * 60 * 1000;
/** Sweep threshold (number of tracked buckets) that triggers a sweep. */
const SWEEP_THRESHOLD = 10_000;

interface Bucket {
  tokens: number;
  lastMs: number;
}

export class TokenBucketLimiter {
  private readonly auth: RateLimitConfig;
  private readonly publish: RateLimitConfig;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RateLimitOptions = {}) {
    this.enabled = options.enabled !== false;
    this.now = options.now ?? (() => Date.now());
    this.auth = normalize(options.auth ?? DEFAULTS.auth, DEFAULTS.auth);
    this.publish = normalize(options.publish ?? DEFAULTS.publish, DEFAULTS.publish);
  }

  /** Configured capacity for a tier (exposed for tests and headers). */
  public capacityFor(tier: RateLimitTier): number {
    return tier === 'auth' ? this.auth.capacity : this.publish.capacity;
  }

  /**
   * Consume one token from the tier bucket for `key`.
   * Always succeeds when the limiter is disabled.
   */
  public take(tier: RateLimitTier, key: string): RateLimitDecision {
    if (!this.enabled) return { ok: true, retryAfterSeconds: 0, limit: 0, remaining: 0 };
    const cfg = tier === 'auth' ? this.auth : this.publish;
    const t = this.now();
    const bucket = this.buckets.get(key);
    let tokens: number;
    let lastMs: number;
    if (bucket === undefined) {
      // Fresh bucket starts full; the first request still consumes a token.
      tokens = cfg.capacity;
      lastMs = t;
    } else {
      const elapsedSeconds = Math.max(0, (t - bucket.lastMs) / 1000);
      tokens = Math.min(cfg.capacity, bucket.tokens + elapsedSeconds * cfg.refillPerSecond);
      lastMs = t;
    }
    if (tokens >= 1) {
      tokens -= 1;
      this.buckets.set(key, { tokens, lastMs });
      return {
        ok: true,
        retryAfterSeconds: 0,
        limit: cfg.capacity,
        remaining: Math.max(0, Math.floor(tokens)),
      };
    }
    this.buckets.set(key, { tokens, lastMs });
    const deficit = 1 - tokens;
    const retryAfter = Math.max(1, Math.ceil(deficit / cfg.refillPerSecond));
    this.maybeSweep(t);
    return { ok: false, retryAfterSeconds: retryAfter, limit: cfg.capacity, remaining: 0 };
  }

  /** Drop buckets that have been idle for over an hour (lazy sweep). */
  private maybeSweep(t: number): void {
    if (this.buckets.size < SWEEP_THRESHOLD) return;
    for (const [key, bucket] of this.buckets) {
      if (t - bucket.lastMs > SWEEP_IDLE_MS) this.buckets.delete(key);
    }
  }
}

function normalize(cfg: RateLimitConfig, fallback: RateLimitConfig): RateLimitConfig {
  const capacity = Number(cfg.capacity);
  const refillPerSecond = Number(cfg.refillPerSecond);
  return {
    capacity:
      Number.isFinite(capacity) && capacity >= 1
        ? Math.min(Math.trunc(capacity), Number.MAX_SAFE_INTEGER)
        : fallback.capacity,
    refillPerSecond:
      Number.isFinite(refillPerSecond) && refillPerSecond > 0
        ? Math.min(refillPerSecond, Number.MAX_SAFE_INTEGER)
        : fallback.refillPerSecond,
  };
}
