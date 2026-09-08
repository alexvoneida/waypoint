-- Sign-in needs to look up a user's password_hash by email before any
-- session exists to make current_app_user() resolve to that user - but
-- users_select_self (0003_rls.sql) only ever lets a row see itself. That is
-- correct for every other read and is exactly why it cannot also serve this
-- one: widening it to permit an email-keyed lookup would let any anonymous
-- request read any account's row, which is the attack the policy exists to
-- stop.
--
-- A single-purpose, security definer function closes only this gap: it
-- returns the two columns a credential check needs and nothing else, and it
-- is not reachable except by name. search_path is pinned so it cannot be
-- retargeted by a session-local search_path change.
create function auth_lookup(p_email citext)
returns table (id uuid, password_hash text)
language sql
security definer
set search_path = public
stable
as $fn$
  select id, password_hash from users where email = p_email
$fn$;

revoke all on function auth_lookup(citext) from public;
grant execute on function auth_lookup(citext) to waypoint_app;
