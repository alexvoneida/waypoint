# Phase 0: De-risk

Phase 0 exists to answer questions that could change the plan before any
code depends on the answers.

## What this phase answers

- Does the Strava API give this project the activity data it needs, on
  terms that will hold up (paid tier, endpoint availability)?
- Does a real camera + Lightroom export pipeline preserve the EXIF
  timestamp this project's core correlation logic depends on?
- Can Postgres/PostGIS run locally and, later, on a realistic managed-host
  free tier?
- Is there enough real archive material (GPS tracks + JPGs) to develop and
  test against?

## Machine-checked (`npm run verify`)

Run `npm run verify` after `npm run db:up`. It checks:

- Node.js major version >= 20.
- The `docker` binary is available and the `waypoint-db` container is
  reachable via `psql`, reporting the PostGIS version.
- The `pgcrypto` extension works (`gen_random_uuid()`).
- `exiftool` is installed (required).
- EXIF timestamps on any JPGs placed in `fixtures/photos/` (optional -
  skipped if the directory is empty). Also reports how many carry
  `OffsetTimeOriginal`, which states the UTC offset the correlation engine
  otherwise has to infer.
- GPX fixture inventory in `fixtures/gpx/` against the four required hiking
  scenario keywords (optional - reported as TODO, not a failure).

## Manual steps (yours)

- [ ] Register a Strava API application and activate the paid Standard
      Tier.
- [ ] Read Strava's September 2026 endpoint deprecation list and confirm
      the endpoints carrying `total_elevation_gain` and `moving_time` are
      not on it.
- [ ] Export a JPG through the real Lightroom preset into
      `fixtures/photos/` and confirm `DateTimeOriginal` survives.
- [ ] Collect GPX files for the four required hiking scenarios into
      `fixtures/gpx/` (see `fixtures/README.md`).
- [ ] Confirm PostGIS availability on the chosen managed-Postgres free
      tier before committing to that host.
- [ ] Identify eight archive outings that have both a GPS activity and
      JPGs.
- [ ] Register a domain.

## Gate

Phase 0 is done when:

- The Strava application is registered and the Standard Tier subscription
  is active.
- The needed Strava endpoints are confirmed outside the deprecation list.
- `npm run verify` passes.
- The GPX fixtures for all four hiking scenarios exist in `fixtures/gpx/`.

If Strava access fails (application rejected, subscription unavailable, or
the needed endpoints are deprecated), the documented fallback is to drop
the Strava OAuth/import stories and promote direct FIT-file upload instead.
