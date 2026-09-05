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

Waypoint is a hiking product, so all four scenarios are hiking. There is no ski or
cycling fixture and there should not be one.

`npm run verify` looks for filenames containing each of the following
keywords. A file can satisfy more than one keyword if applicable.

- `hike` - a straightforward day hike. Baseline case for the correlation logic.
- `gap` - a track with a signal gap in a canyon or similar terrain. Tests
  behavior when the two GPX points bracketing a photo timestamp are far apart
  in time.
- `paused` - a track with a paused/resumed activity. Tests a time
  discontinuity in the track that isn't a signal gap.
- `multiday` - a multi-day backpacking trip. Tests that the offset search used to align
  camera time with GPS time is not ambiguous across a window longer than 22
  hours.

## Required photo fixtures

At least one JPG exported through the real Lightroom export preset,
confirming that `DateTimeOriginal` survives the export pipeline.

Photos that also carry `OffsetTimeOriginal` are extra valuable: the tag states the
UTC offset that the correlation engine infers by search, which makes the photo a
labelled test case for offset inference at no authoring cost.
