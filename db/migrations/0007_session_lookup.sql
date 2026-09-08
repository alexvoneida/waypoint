-- Resolving a bearer token has the same shape as signing in: the caller has no
-- identity until the token is resolved, so sessions_own can never match. The
-- first implementation worked around this by prefixing every token with the
-- user's id in plaintext, which made the token self-routing but meant anyone
-- who saw one - in a proxy log, a crash report, devtools - learned the account
-- id, and that two tokens belonged to the same account.
--
-- Looking the session up by the hash it is already stored under removes the
-- need for that prefix, so a token can be pure randomness identifying nothing
-- on its own. These take the hash, never the token.
create function session_lookup(p_token_hash bytea)
returns table (session_id uuid, user_id uuid)
language sql
security definer
set search_path = public
volatile
as $fn$
  update sessions
  set last_used_at = now()
  where token_hash = p_token_hash and expires_at > now()
  returning id, user_id
$fn$;

-- Revocation removes the row rather than expiring it: a session that is gone
-- cannot be resurrected by a clock change, and there is nothing here worth
-- keeping once the user has signed out.
create function session_revoke(p_token_hash bytea) returns boolean
language sql
security definer
set search_path = public
volatile
as $fn$
  delete from sessions where token_hash = p_token_hash returning true
$fn$;

grant select, update, delete on sessions to waypoint_definer;
alter function session_lookup(bytea) owner to waypoint_definer;
alter function session_revoke(bytea) owner to waypoint_definer;

revoke all on function session_lookup(bytea) from public;
revoke all on function session_revoke(bytea) from public;
grant execute on function session_lookup(bytea) to waypoint_app;
grant execute on function session_revoke(bytea) to waypoint_app;
