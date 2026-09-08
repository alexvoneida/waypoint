-- invites_redeem (0003_rls.sql) is an UPDATE policy meant to let an
-- anonymous caller validate and consume a code in one statement. It cannot
-- actually fire for that caller: Postgres requires a row to also pass an
-- applicable SELECT policy before UPDATE can touch it, and
-- invites_select_own only ever matches a redeemer's own past invite -
-- something an anonymous request has by definition not yet established.
-- Verified directly: a scratch table with only `for update using (flag is
-- null)` and a `for select using (false)` policy also updates zero rows.
--
-- Granting anonymous SELECT would fix the interaction but reopen exactly
-- what invites_select_own exists to prevent - a visitor enumerating live
-- codes. Instead, a security definer function performs precisely the
-- validated update invites_redeem already intended (matching code,
-- unexpired, unredeemed) and returns only whether it succeeded.
create function redeem_invite(p_code text, p_user_id uuid) returns boolean
language sql
security definer
set search_path = public
as $fn$
  update invites
  set redeemed_by = p_user_id, redeemed_at = now()
  where code = p_code and redeemed_by is null and expires_at > now()
  returning true
$fn$;

revoke all on function redeem_invite(text, uuid) from public;
grant execute on function redeem_invite(text, uuid) to waypoint_app;
