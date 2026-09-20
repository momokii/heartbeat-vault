// In-memory per-IP token bucket for login rate limiting.
// Postgres-backed limiter is deferred to scaling — see ADR.
// Window: 5 attempts per 15 minutes → 429 with Retry-After.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

type Bucket = { readonly count: number; readonly windowStart: number };
const buckets = new Map<string, Bucket>();

export function checkRateLimit(ip: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const entry = buckets.get(ip);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    buckets.set(ip, { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (entry.count < MAX_ATTEMPTS) {
    buckets.set(ip, { count: entry.count + 1, windowStart: entry.windowStart });
    return { allowed: true };
  }
  const retryAfterSec = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
  return { allowed: false, retryAfterSec: retryAfterSec > 0 ? retryAfterSec : 1 };
}

export function resetRateLimitForTests(): void {
  buckets.clear();
}

export function resetRateLimitForIp(ip: string): void {
  buckets.delete(ip);
}
