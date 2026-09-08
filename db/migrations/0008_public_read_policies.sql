-- visible_entries and public_profiles cover the entry row and its author,
-- but a public entry page also needs the activity it was recorded from and
-- its photographs -- and activities_own / photos_own / photo_locations_own
-- (0003_rls.sql) are owner-only, exactly like entries_own. Nothing before
-- this migration lets an anonymous or non-owning reader select those rows
-- even when the entry itself is public.
--
-- This follows the pattern already used for likes_visible and
-- comments_visible: an additional permissive SELECT policy, resolved through
-- visible_entries so entry/account visibility is still decided in one place,
-- added alongside the existing owner-only policy rather than replacing it.
create policy activities_visible on activities
  for select using (
    exists (select 1 from visible_entries v where v.activity_id = activities.id)
  );

create policy photos_visible on photos
  for select using (
    exists (select 1 from visible_entries v where v.id = photos.entry_id)
  );

create policy photo_locations_visible on photo_locations
  for select using (
    exists (select 1 from photos p
            join visible_entries v on v.id = p.entry_id
            where p.id = photo_locations.photo_id)
  );
