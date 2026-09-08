# Phase 3: The entry page — MVP gate

## Gate

Reached. One real outing is live at a public URL, correctly geotagged, showing
its statistics, and legible on a phone.

```
/e/waypointseed/seeded-morning-hike-3

distance      16.2 km          from the track geometry
time          5h 30m           from the track endpoints
elevation gain   omitted       GPX source, and never computed
photographs   2 placed, 0 unplaced
offset        UTC-6 (America/Denver), inferred unattended
confidence    medium (the offset was ambiguous, so the cap applies)
placement     0.000 m from the track
```

## What exists

**Write path.** `POST /api/activities` parses GPX into `LINESTRING ZM` with M
carrying epoch seconds, storing a simplified 2D line alongside it.
`POST /api/entries` creates the draft and enqueues per-photo EXIF extraction.
The `correlate` job is a fan-in barrier gated on a database predicate rather
than a step counter, so it is idempotent and survives retries. Publish assigns
the slug and revalidates.

**Read path.** `/e/[handle]/[slug]` reads through `visible_entries` and returns
404 rather than 403 on a miss. MapLibre on MapTiler Outdoor draws the route and
a pin per located photograph; an inline SVG plots elevation against distance
with a marker per frame; hovering any of the three highlights the other two.

**Numbers that matter.** The served GeoJSON is ~24 KB because the map reads the
simplified track, not the full one. The elevation series is downsampled to 301
points server-side; one of these tracks is 15,047 points. Total page weight
~70 KB.

## Three bugs worth remembering

**Naive timestamps were being silently dropped.** The correlation query cast
`captured_naive::text`, which Postgres renders with a space separator
(`2026-08-22 09:23:27`). The engine requires the ISO `T` and discards anything
it cannot parse, so every photograph came back unplaced with
`no-offset-resolved` and nothing errored. Fixed with an explicit `to_char`.

**The correlation barrier could never fire for a failed batch.** It triggered on
the event sent only when EXIF extraction *succeeds*, but the barrier waits for
every photograph to leave `uploaded` — and failing is one of the ways that
happens. An entry whose last photograph failed would stall forever with no
locations and no error. There is now a separate `photo/exif.settled` event that
fires on both outcomes.

**The map rendered nothing, silently.** maplibre-gl v6 loads its tile-parsing
worker through `new Worker(new URL(..., import.meta.url))` inside a prebuilt
dist file. Turbopack does not resolve that reference, so the worker URL came out
empty, the worker threw, and the style never finished loading — a blank canvas
with no console error. The worker is now served same-origin from its installed
package.

## Known limitations

- **The maplibre worker is read from `node_modules` at request time**, using
  path arithmetic from `process.cwd()`. That holds in development. A traced or
  standalone production build may prune the file, since nothing imports it
  statically. Copying it into `public/` at build time is the durable fix and
  should happen before deployment.
- Discovery at `/` is deliberately minimal; real discovery is Phase 4.
- The studio correlation review — the offset slider with live client-side
  re-interpolation — is deferred. Correlation currently resolves unattended on
  every real outing, so it is a correction tool for a case that has not
  occurred.
- `occurred_on` uses the activity's UTC start date. Provisional until the
  timezone lookup lands.
