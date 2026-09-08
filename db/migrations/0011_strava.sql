-- Phase 5: Strava OAuth (N-1), the resumable historical listing (N-2), and
-- import (N-3).

-- §6's five states. 'listing' and 'importing' are what the studio renders as
-- work in progress; 'ready' means a listing exists to choose from, and 'done'
-- that the author has finished with the backfill.
create type backfill_t as enum ('none', 'listing', 'ready', 'importing', 'done');

alter table strava_connections
  add column backfill_status backfill_t not null default 'none',
  -- Strava's rate limit is a hard stop, not a slowdown: the listing cannot
  -- proceed until the window rolls over. Storing when that happens is what
  -- lets the studio say "paused until 14:15" instead of "something failed".
  add column rate_limited_until timestamptz,
  add column listing_error text;

-- The cursor is the `before` parameter of the next page request: activities
-- are listed newest-first, so the oldest start_date seen so far is exactly
-- where a resumed scan picks up. It was text (unused, from the Phase 2
-- schema); a timestamptz cannot be handed to the API in the wrong shape.
alter table strava_connections
  alter column backfill_cursor type timestamptz using null;

-- The cached listing N-2 selects from. Reading Strava directly on every page
-- of the selector would spend the rate limit on scrolling; the scan runs once
-- and this table answers the UI.
--
-- Columns mirror the *summary* activity object, which already carries
-- total_elevation_gain and moving_time (§14 checklist), so no per-activity
-- detail call is needed to render a row.
create table strava_activities (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  user_id           uuid not null references users on delete cascade,
  strava_id         bigint not null,
  name              text not null,
  -- Strava's own sport_type string ('Hike', 'Run', 'Ride', ...), not sport_t.
  -- The selector filters on what Strava reported; mapping into sport_t is a
  -- lossy decision that belongs at import, not in the cache.
  sport_type        text not null,
  start_date        timestamptz not null,
  -- The offset actually in force on the day, from `utc_offset`. Never parsed
  -- out of the `(GMT-07:00)` prefix of `timezone`, which carries the zone's
  -- standard offset and is an hour wrong all summer (§4).
  utc_offset_s      integer not null,
  -- The IANA name from that same label, for display only.
  timezone          text,
  distance_m        double precision not null,
  ascent_m          double precision,
  moving_s          integer,
  elapsed_s         integer not null,
  -- Set when this listing row has been imported. Null is "not imported yet",
  -- and the foreign key's `on delete set null` means deleting an imported
  -- activity offers it for import again rather than orphaning the row.
  activity_id       uuid references activities on delete set null,
  imported_at       timestamptz,
  import_error      text,
  unique (user_id, strava_id)
);
create index on strava_activities (user_id, start_date desc);

-- The OAuth `state` nonce, stored server-side so the callback validates
-- against something the browser could not have chosen. Single-use: consumed
-- by deletion in the same statement that reads it, so a replayed callback
-- finds nothing.
create table strava_oauth_states (
  nonce      text primary key,
  created_at timestamptz not null default now(),
  user_id    uuid not null references users on delete cascade,
  expires_at timestamptz not null
);
create index on strava_oauth_states (expires_at);

alter table strava_activities   enable row level security;
alter table strava_oauth_states enable row level security;

create policy strava_activities_own on strava_activities
  for all using (user_id = current_app_user()) with check (user_id = current_app_user());

create policy strava_oauth_states_own on strava_oauth_states
  for all using (user_id = current_app_user()) with check (user_id = current_app_user());
