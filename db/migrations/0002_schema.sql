-- Waypoint schema. Every table carries id and created_at; both are spelled out
-- here rather than elided as they are in the requirements.

create extension if not exists citext;

create type visibility_t      as enum ('public', 'private');
create type activity_source_t as enum ('gpx', 'fit', 'strava');
create type sport_t           as enum ('hike', 'other');
create type offset_source_t   as enum ('assumed', 'watch_face', 'manual');
create type entry_status_t    as enum ('draft', 'published');
create type photo_status_t    as enum ('uploaded', 'processing', 'ready', 'failed');
create type locate_method_t   as enum ('interpolated', 'clamped', 'manual', 'exif');
create type confidence_t      as enum ('high', 'medium', 'low');
create type link_status_t     as enum ('auto', 'suggested', 'confirmed', 'rejected');

create table users (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  handle             citext not null unique,
  email              citext not null unique,
  display_name       text not null,
  password_hash      text not null,
  home_zone          text,
  profile_visibility visibility_t not null default 'private',
  privacy_center     geography(Point, 4326),
  privacy_radius_m   integer not null default 0 check (privacy_radius_m >= 0)
);

create table invites (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  code        text not null unique,
  issued_to   citext,
  redeemed_by uuid references users on delete set null,
  redeemed_at timestamptz,
  expires_at  timestamptz not null
);

create table sessions (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  user_id      uuid not null references users on delete cascade,
  -- Stored hashed. A leaked database backup should not hand over live
  -- sessions; a session token is a bearer credential exactly as a password is.
  token_hash   bytea not null unique,
  expires_at   timestamptz not null,
  last_used_at timestamptz,
  user_agent   text
);
create index on sessions (user_id);
create index on sessions (expires_at);

create table waitlist_signups (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  email      citext not null unique
);

create table camera_profiles (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  user_id        uuid not null references users on delete cascade,
  make           text not null,
  model          text not null,
  body_serial    text,
  clock_offset_s integer not null default 0,
  offset_source  offset_source_t not null default 'assumed',
  calibrated_at  timestamptz,
  unique (user_id, make, model, body_serial)
);

create table activities (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  user_id          uuid not null references users on delete cascade,
  source           activity_source_t not null,
  external_id      text,
  name             text not null,
  sport            sport_t not null default 'hike',
  started_at       timestamptz not null,
  ended_at         timestamptz not null,
  local_zone       text,
  track            geometry(LineStringZM, 4326) not null,
  track_simplified geometry(LineString, 4326) not null,
  distance_m       double precision not null,
  -- Null for GPX and FIT sources. Never derived from track elevation: a
  -- positive-delta sum overstates gain badly, so this nullability is the
  -- enforcement mechanism and must not be relaxed.
  ascent_m         double precision,
  moving_s         integer,
  elapsed_s        integer not null,
  unique (user_id, source, external_id)
);
create index on activities using gist (track_simplified);
create index on activities (user_id);

create table trails (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  slug               text not null unique,
  name               text not null,
  canonical_geom     geometry(LineString, 4326) not null,
  centroid           geography(Point, 4326) not null,
  public_entry_count integer not null default 0
);
create index on trails using gist (canonical_geom);
create index on trails using gist (centroid);

create table entries (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  user_id       uuid not null references users on delete cascade,
  activity_id   uuid not null references activities on delete cascade,
  trail_id      uuid references trails on delete set null,
  lead_photo_id uuid,
  slug          text,
  title         text not null,
  notes         text,
  occurred_on   date not null,
  status        entry_status_t not null default 'draft',
  visibility    visibility_t not null default 'public',
  published_at  timestamptz,
  conditions    jsonb,
  comments_open boolean not null default true,
  unique (user_id, slug),
  -- A slug exists only once published, which is what makes a draft
  -- unaddressable rather than merely hidden.
  constraint published_entries_have_a_slug
    check ((status = 'published') = (slug is not null))
);
create index on entries (user_id, occurred_on desc);
create index on entries (trail_id);

create table trail_links (
  trail_id    uuid not null references trails on delete cascade,
  activity_id uuid not null references activities on delete cascade,
  created_at  timestamptz not null default now(),
  score_fwd   real not null,
  score_rev   real not null,
  status      link_status_t not null,
  primary key (trail_id, activity_id)
);

create table photos (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  entry_id       uuid not null references entries on delete cascade,
  camera_id      uuid references camera_profiles on delete set null,
  checksum       bytea not null,
  key_original   text not null,
  key_full       text,
  key_web        text,
  key_thumb      text,
  width          integer,
  height         integer,
  blur_hash      text,
  sort_order     integer,
  hidden         boolean not null default false,
  captured_naive timestamp,
  captured_at    timestamptz,
  exif           jsonb,
  status         photo_status_t not null default 'uploaded',
  unique (entry_id, checksum)
);
create index on photos (entry_id);

alter table entries
  add constraint entries_lead_photo_fkey
  foreign key (lead_photo_id) references photos on delete set null;

create table photo_locations (
  photo_id         uuid primary key references photos on delete cascade,
  created_at       timestamptz not null default now(),
  geom             geography(Point, 4326) not null,
  elevation_m      double precision,
  method           locate_method_t not null,
  confidence       confidence_t not null,
  gap_seconds      real,
  applied_offset_s integer not null,
  distance_along_m double precision
);
create index on photo_locations using gist (geom);

create table likes (
  entry_id   uuid not null references entries on delete cascade,
  user_id    uuid not null references users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (entry_id, user_id)
);

create table comments (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  entry_id   uuid not null references entries on delete cascade,
  user_id    uuid not null references users on delete cascade,
  body       text not null check (length(body) between 1 and 2000),
  deleted_at timestamptz
);
create index on comments (entry_id, created_at);

create table strava_connections (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz not null default now(),
  user_id                 uuid not null references users on delete cascade unique,
  athlete_id              bigint not null,
  access_token_encrypted  bytea not null,
  refresh_token_encrypted bytea not null,
  expires_at              timestamptz not null,
  scopes                  text not null,
  backfill_cursor         text
);
