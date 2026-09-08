-- Phase 6: the privacy radius (A-4).
--
-- §9 calls a track that terminates at a home address the single most sensitive
-- thing this product publishes. The columns have been in the schema since
-- 0002; what is added here is the enforcement, and the shape of it matters as
-- much as the trimming does.
--
-- The rule this migration establishes: after it, a public reader has no path
-- to an unclipped track at all. 0008 gave activities a permissive SELECT
-- policy so an anonymous reader could load a public entry's activity row --
-- but a row-level policy chooses rows, it cannot rewrite a column, so that
-- policy hands back the untrimmed geometry by construction. Clipping in the
-- application instead would mean every read path remembering to do it, and
-- §9's whole argument is that a check repeated at N call sites is a check
-- that is wrong at one of them. So the policy goes, and visible_activities
-- replaces it: one view, clipped, restricted to the entries visible_entries
-- already resolved.

-- Null center or zero radius means the feature is off, and the geometry comes
-- back untouched rather than through a no-op ST_Difference.
--
-- ST_Buffer over geography takes its distance in metres and handles the
-- projection itself, which is why privacy_radius_m can stay a plain integer
-- count of metres rather than degrees of anything.
create function privacy_clip(geom geometry, center geography, radius_m integer)
returns geometry language sql stable parallel safe as $fn$
  select case
    when center is null or radius_m <= 0 then geom
    else st_difference(geom, st_buffer(center, radius_m)::geometry)
  end
$fn$;

-- Deliberately false, never null, for a photograph that has no location yet:
-- an unplaced photo is not inside the radius, and a null here would propagate
-- through the `not (...)` in the policies below and make every uncorrelated
-- photograph vanish from its own entry.
create function within_privacy_radius(point geography, center geography, radius_m integer)
returns boolean language sql stable parallel safe as $fn$
  select point is not null
     and center is not null
     and radius_m > 0
     and st_dwithin(point, center, radius_m)
$fn$;

-- Not security_invoker, for the same reason visible_entries is not: the view
-- reads the base tables with the owner's rights so its own WHERE clause is
-- the only filter. The EXISTS against visible_entries is what keeps entry and
-- account visibility resolved in one place -- this view narrows that answer
-- further, it never widens it.
create view visible_activities as
  select
    a.id, a.user_id, a.source, a.external_id, a.name, a.sport,
    a.started_at, a.ended_at, a.local_zone,
    privacy_clip(a.track, u.privacy_center, u.privacy_radius_m) as track,
    privacy_clip(a.track_simplified, u.privacy_center, u.privacy_radius_m) as track_simplified,
    a.distance_m, a.ascent_m, a.moving_s, a.elapsed_s, a.created_at
  from activities a
  join users u on u.id = a.user_id
  where exists (select 1 from visible_entries v where v.activity_id = a.id);

grant select on visible_activities to waypoint_app;

-- The elevation profile is the one public read that cannot come from the view.
-- It locates each track point along the line to get a distance for the x
-- axis, and ST_LineLocatePoint takes a LineString -- which a clipped track,
-- being a MultiLineString wherever the radius bit into it, is not.
--
-- Measuring against the unclipped line is also the more honest answer: the
-- profile's x axis is distance into the outing, and trimming the start of a
-- track does not move where the summit was. What must not survive the clip is
-- coordinates, and this returns none -- only elevation against distance, with
-- the points inside the radius dropped so the profile shows the same gap the
-- map does.
create function visible_elevation_series(activity uuid)
returns table (dist_m double precision, ele double precision)
language sql stable as $fn$
  select
    st_linelocatepoint(st_force2d(a.track), pt.geom) * a.distance_m as dist_m,
    st_z(pt.geom) as ele
  from activities a
  join users u on u.id = a.user_id,
  lateral st_dumppoints(a.track) as pt(path, geom)
  where a.id = activity
    and exists (select 1 from visible_entries v where v.activity_id = a.id)
    and not within_privacy_radius(pt.geom::geography, u.privacy_center, u.privacy_radius_m)
  order by (pt.path)[1]
$fn$;

grant execute on function visible_elevation_series(uuid) to waypoint_app;

-- Replaced, not amended. A public reader reaches an activity through
-- visible_activities from here on; the base table keeps only its owner-only
-- policy, exactly like entries.
drop policy activities_visible on activities;

-- A photograph inside the radius is excluded from public views entirely, not
-- merely stripped of its pin: §9 says photos inside the radius are excluded,
-- and a frame that still appears in the strip while its neighbours plot on
-- the map is its own kind of tell.
--
-- It has to be a function, and the reason is worth stating: photos needs to
-- consult photo_locations to answer "is this one inside the radius", and
-- photo_locations needs to consult photos to answer "is its entry visible".
-- Written as two policies reading each other's tables that is a cycle, and
-- Postgres rejects it outright (42P17, infinite recursion in policy). A
-- security definer function reads the join once with its owner's rights, so
-- neither policy re-enters the other.
--
-- Same shape as auth_lookup and redeem_invite (0004-0007): a static body, a
-- pinned search_path, and an owner role that can do nothing except be this
-- function. It returns a boolean about one photo id and nothing else.
create role waypoint_privacy nologin;
alter role waypoint_privacy bypassrls;
grant usage on schema public to waypoint_privacy;
grant select (id, entry_id) on photos to waypoint_privacy;
grant select (photo_id, geom) on photo_locations to waypoint_privacy;
grant select (id, user_id) on entries to waypoint_privacy;
grant select (id, privacy_center, privacy_radius_m) on users to waypoint_privacy;

create function photo_hidden_by_privacy(photo uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from photo_locations pl
    join photos p on p.id = pl.photo_id
    join entries e on e.id = p.entry_id
    join users u on u.id = e.user_id
    where pl.photo_id = photo
      and within_privacy_radius(pl.geom, u.privacy_center, u.privacy_radius_m)
  )
$fn$;

alter function photo_hidden_by_privacy(uuid) owner to waypoint_privacy;
grant execute on function photo_hidden_by_privacy(uuid) to waypoint_app;

drop policy photos_visible on photos;
create policy photos_visible on photos
  for select using (
    exists (select 1 from visible_entries v where v.id = photos.entry_id)
    and not photo_hidden_by_privacy(photos.id)
  );

drop policy photo_locations_visible on photo_locations;
create policy photo_locations_visible on photo_locations
  for select using (
    exists (
      select 1 from photos p
      join visible_entries v on v.id = p.entry_id
      where p.id = photo_locations.photo_id
    )
    and not photo_hidden_by_privacy(photo_locations.photo_id)
  );
