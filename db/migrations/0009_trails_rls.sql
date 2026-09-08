-- `trails` is the only table in the schema with no row-level security, so any
-- authenticated request can currently rename or delete any trail. Close that.

alter table trails enable row level security;

-- Trails are public aggregations and the trail page is a public surface.
-- Unlike an entry, there is nothing per-account to hide on a trail row itself:
-- its existence is not private, and which entries appear on it is already
-- governed by visible_entries. So, unlike every owner-scoped policy above,
-- this select policy has no using clause restricting rows at all.
create policy trails_select_all on trails
  for select using (true);

-- Founding a trail happens during ingest as the acting user, so "some
-- authenticated user" is the right and only condition -- trails have no
-- single owner column to check against. This is deliberately permissive: any
-- signed-in user can found or edit any trail. A follower-era revisit should
-- reconsider this once trails have real ownership or moderation.
create policy trails_insert_authenticated on trails
  for insert with check (current_app_user() is not null);
create policy trails_update_authenticated on trails
  for update using (current_app_user() is not null) with check (current_app_user() is not null);

-- No delete policy. Nothing in the product deletes a trail, and a missing
-- policy is a safer default than a permissive one.
