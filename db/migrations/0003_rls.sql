-- Row-level security.
--
-- The application connects as waypoint_app, which owns nothing. That is the
-- whole mechanism: a table's owner bypasses its own RLS policies unless the
-- table forces them, so an application connecting as the owner has policies
-- that look right and enforce nothing. The migration role owns the tables and
-- the application role only ever reads through policies.

create role waypoint_app login password 'waypoint-app-dev-only';

grant usage on schema public to waypoint_app;
grant select, insert, update, delete on all tables in schema public to waypoint_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to waypoint_app;

-- The acting user for the current transaction, or null when unauthenticated.
-- Set with `select set_config('app.user_id', $1, true)` inside the transaction,
-- so it cannot leak to the next borrower of a pooled connection.
create function current_app_user() returns uuid
language sql stable as $fn$
  select nullif(current_setting('app.user_id', true), '')::uuid
$fn$;

-- Effective visibility is the more restrictive of the account's and the
-- entry's, resolved in exactly one place. Public read paths use this view and
-- nothing else.
--
-- Deliberately NOT security_invoker: the view reads the base tables with the
-- owner's rights so its WHERE clause is the only filter. Marking it
-- security_invoker would subject it to the owner-only policies below, and it
-- would return nothing to a visitor.
create view visible_entries as
  select e.*
  from entries e
  join users u on u.id = e.user_id
  where e.status = 'published'
    and e.visibility = 'public'
    and u.profile_visibility = 'public';

grant select on visible_entries to waypoint_app;

-- A profile header stays public even when the account is private. It is its own
-- view so that publishing a handle never means exposing an email or a hash.
create view public_profiles as
  select id, handle, display_name, profile_visibility, created_at
  from users;

grant select on public_profiles to waypoint_app;

alter table users              enable row level security;
alter table invites            enable row level security;
alter table sessions           enable row level security;
alter table waitlist_signups   enable row level security;
alter table camera_profiles    enable row level security;
alter table activities         enable row level security;
alter table entries            enable row level security;
alter table photos             enable row level security;
alter table photo_locations    enable row level security;
alter table likes              enable row level security;
alter table comments           enable row level security;
alter table strava_connections enable row level security;
alter table trail_links        enable row level security;

-- A user reads and edits only their own row. Everything a visitor may see about
-- an account comes from public_profiles.
create policy users_select_self on users
  for select using (id = current_app_user());
create policy users_update_self on users
  for update using (id = current_app_user()) with check (id = current_app_user());
-- Account creation happens before there is an acting user, so the invite check
-- cannot live here. It is enforced in the redemption query, which validates and
-- consumes the code in the same transaction as the insert.
create policy users_insert on users
  for insert with check (true);

-- Invites and the waitlist are written by unauthenticated visitors and never
-- read back by them. Without a select policy a visitor cannot enumerate codes
-- or harvest the waitlist even though they can write to both.
create policy invites_select_own on invites
  for select using (redeemed_by = current_app_user());
create policy invites_redeem on invites
  for update using (redeemed_by is null) with check (true);
create policy waitlist_insert on waitlist_signups
  for insert with check (true);

create policy sessions_own on sessions
  for all using (user_id = current_app_user()) with check (user_id = current_app_user());

create policy camera_profiles_own on camera_profiles
  for all using (user_id = current_app_user()) with check (user_id = current_app_user());

create policy activities_own on activities
  for all using (user_id = current_app_user()) with check (user_id = current_app_user());

create policy strava_connections_own on strava_connections
  for all using (user_id = current_app_user()) with check (user_id = current_app_user());

-- Owner-only on the base table. A visitor's read of a published entry goes
-- through visible_entries, which is what keeps the two-switch resolution in one
-- place. A draft is therefore invisible to everyone but its author.
create policy entries_own on entries
  for all using (user_id = current_app_user()) with check (user_id = current_app_user());

create policy trail_links_own on trail_links
  for all using (
    exists (select 1 from activities a
            where a.id = trail_links.activity_id and a.user_id = current_app_user())
  ) with check (
    exists (select 1 from activities a
            where a.id = trail_links.activity_id and a.user_id = current_app_user())
  );

create policy photos_own on photos
  for all using (
    exists (select 1 from entries e
            where e.id = photos.entry_id and e.user_id = current_app_user())
  ) with check (
    exists (select 1 from entries e
            where e.id = photos.entry_id and e.user_id = current_app_user())
  );

create policy photo_locations_own on photo_locations
  for all using (
    exists (select 1 from photos p join entries e on e.id = p.entry_id
            where p.id = photo_locations.photo_id and e.user_id = current_app_user())
  ) with check (
    exists (select 1 from photos p join entries e on e.id = p.entry_id
            where p.id = photo_locations.photo_id and e.user_id = current_app_user())
  );

-- A social interaction is possible exactly where the entry is visible, and that
-- is not a second check: it resolves the entry through the same view readers
-- use, with the acting user as the viewer. The clause takes a viewer rather than
-- branching on owner-or-anonymous, so adding followers later changes the view
-- and not these policies.
create policy likes_visible on likes
  for select using (
    exists (select 1 from visible_entries v where v.id = likes.entry_id)
    or exists (select 1 from entries e
               where e.id = likes.entry_id and e.user_id = current_app_user())
  );
create policy likes_write_own on likes
  for all using (user_id = current_app_user())
  with check (
    user_id = current_app_user()
    and exists (select 1 from visible_entries v where v.id = likes.entry_id)
  );

create policy comments_visible on comments
  for select using (
    deleted_at is null
    and (
      exists (select 1 from visible_entries v where v.id = comments.entry_id)
      or exists (select 1 from entries e
                 where e.id = comments.entry_id and e.user_id = current_app_user())
    )
  );
create policy comments_insert on comments
  for insert with check (
    user_id = current_app_user()
    and exists (select 1 from visible_entries v
                where v.id = comments.entry_id and v.comments_open)
  );
-- Soft-deletable by the comment's author or by the entry's author.
create policy comments_delete on comments
  for update using (
    user_id = current_app_user()
    or exists (select 1 from entries e
               where e.id = comments.entry_id and e.user_id = current_app_user())
  ) with check (true);
