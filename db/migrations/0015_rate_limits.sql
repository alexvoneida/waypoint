-- Fixed-window rate limiting, shared across instances.
--
-- The previous limiter (apps/web/src/lib/rate-limit.ts) kept counts in one
-- Node process's heap. On Vercel that heap does not persist or share across
-- invocations, so the limiter was close to a no-op in production. This table
-- makes the window state visible to every instance the same way sessions
-- already are.
create table rate_limit_windows (
  key      text primary key,
  count    integer not null,
  reset_at timestamptz not null
);

alter table rate_limit_windows enable row level security;

-- Not scoped to current_app_user(): a key is already namespaced by the
-- caller (e.g. "signin:ip:203.0.113.4"), and rows here are never read back on
-- behalf of a viewer, only incremented by the app itself. RLS is still
-- enabled, per this schema's convention that no table skips it, but with a
-- single open policy since there is no per-user boundary for it to enforce.
create policy rate_limit_windows_all on rate_limit_windows
  for all using (true) with check (true);
