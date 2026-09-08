// In-memory fixed-window rate limiter.
//
// This map lives in one Node process's heap. It does not survive a restart,
// is not shared across multiple instances behind a load balancer, and gives
// every instance its own independent budget - so a deployment with N
// instances effectively allows N times the configured limit. That is an
// accepted Phase 2 simplification, not an oversight: before this app runs on
// more than one node, this needs to move to Redis or a Postgres table shared
// across instances.
const windows = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function checkRateLimit(key: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + options.windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (existing.count < options.limit) {
    existing.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  return { allowed: false, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
}
