import { readPublic } from "./db";

// Fixed-window counters in `rate_limit_windows` (0015_rate_limits.sql),
// shared across every instance instead of one process's heap. The upsert
// below is the whole mechanism: `on conflict` resolves concurrently under
// Postgres's own row lock, so two requests racing the same key still get a
// correct, serialized count rather than both reading a stale one.
export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export async function checkRateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  const { rows } = await readPublic((client) =>
    client.query<{ count: number; reset_at: Date }>(
      `insert into rate_limit_windows (key, count, reset_at)
       values ($1, 1, now() + ($2 || ' milliseconds')::interval)
       on conflict (key) do update
       set
         count = case
           when rate_limit_windows.reset_at <= now() then 1
           else rate_limit_windows.count + 1
         end,
         reset_at = case
           when rate_limit_windows.reset_at <= now() then now() + ($2 || ' milliseconds')::interval
           else rate_limit_windows.reset_at
         end
       returning count, reset_at`,
      [key, options.windowMs],
    ),
  );

  const row = rows[0];
  if (!row) {
    // The upsert always returns exactly one row; this is unreachable in
    // practice, and failing open would defeat the point of a rate limiter.
    throw new Error(`rate limit upsert for "${key}" returned no row`);
  }

  if (row.count <= options.limit) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const retryAfterSeconds = Math.ceil((row.reset_at.getTime() - Date.now()) / 1000);
  return { allowed: false, retryAfterSeconds: Math.max(retryAfterSeconds, 0) };
}
