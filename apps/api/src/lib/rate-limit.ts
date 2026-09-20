// In-memory per-IP token bucket for login + 2FA rate limiting.
// Postgres-backed limiter is deferred to scaling — see ADR.
// login: 5 attempts per 15 minutes; 2fa: 10 per 15 minutes → 429 with Retry-After.
const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { login: 5, '2fa': 10 } as const;
export type RateLimitScope = keyof typeof LIMITS;

type Bucket = { readonly count: number; readonly windowStart: number };
const buckets = new Map<string, Bucket>();

export function checkRateLimit(
  ip: string,
  scope: RateLimitScope = 'login',
): { allowed: boolean; retryAfterSec?: number } {
  const max = LIMITS[scope];
  const key = `${scope}:${ip}`;
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (entry.count < max) {
    buckets.set(key, { count: entry.count + 1, windowStart: entry.windowStart });
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
