-- The two security definer functions run as their owner. Owned by the
-- migration role they would run as a superuser, which is far more authority
-- than either needs: a pinned search_path and a static body are what keeps
-- that safe, and both are properties of the code rather than of the grant.
--
-- This role is what they actually need and nothing more. It cannot log in, so
-- the only way to act as it is to call one of these two functions by name.
create role waypoint_definer nologin;

-- BYPASSRLS is the point of the role: both functions exist precisely because
-- the caller has no identity yet, so no policy can match them. Scoped to a
-- role that owns two static functions and holds rights on two tables, this is
-- a much smaller grant than the superuser it replaces.
alter role waypoint_definer bypassrls;

grant usage on schema public to waypoint_definer;
grant select (id, email, password_hash) on users to waypoint_definer;
grant select, update on invites to waypoint_definer;

alter function auth_lookup(citext) owner to waypoint_definer;
alter function redeem_invite(text, uuid) owner to waypoint_definer;
