# Fixtures

This directory holds test fixtures used during Phase 0 and later development.
Its contents are gitignored (except this file and `.gitkeep` placeholders)
because they are personal photography and large binary GPS files that do not
belong in a public repository.

## Layout

- `fixtures/gpx/` - GPX track files covering the required test scenarios.
- `fixtures/photos/` - JPG photos exported through a real camera/Lightroom
  workflow, used to verify EXIF timestamp handling.

## Required GPX scenarios

Waypoint is a hiking product, so both scenarios are hiking. There is no ski or
cycling fixture and there should not be one.

Tracks come from Strava rather than from device exports, so two scenarios that an
earlier plan required have been dropped rather than left permanently unmet:
`paused` (Strava's streams flatten the segment boundaries a pause creates, so the
distinction never reaches us) and `multiday` (nothing in the engine now depends on
activity length - see the admissible-set handling in the correlation package).

`npm run verify` looks for filenames containing each of the following
keywords. A file can satisfy more than one keyword if applicable.

- `hike` - a straightforward day hike. Baseline case for the correlation logic.
- `gap` - a track with a signal gap in a canyon or similar terrain. Tests
  behavior when the two GPX points bracketing a photo timestamp are far apart
  in time.

## Required photo fixtures

At least one JPG exported through the real Lightroom export preset,
confirming that `DateTimeOriginal` survives the export pipeline.

Photos that also carry `OffsetTimeOriginal` are extra valuable: the tag states the
UTC offset that the correlation engine infers by search, which makes the photo a
labelled test case for offset inference at no authoring cost.
