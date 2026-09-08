# Phase 1: Correlation engine, headless

No database, no framework, no interface. A library and a command-line tool, so
the hardest part of the product is finished and tested before anything is built
on top of it.

## What exists

`packages/correlation` — dependency-free TypeScript, no build step. Node runs it
by stripping types, which keeps the same source usable from a native client
later.

| Module | Responsibility |
|---|---|
| `gpx.ts` | GPX 1.1 to a sorted point array. Malformed input throws with a line number. |
| `offset.ts` | Candidate offsets, scoring, and the admissible set. |
| `interpolate.ts` | Binary search for the bracketing pair, linear interpolation. |
| `confidence.ts` | Gap and speed bands, minimum across signals. |
| `correlate.ts` | The pipeline, including EXIF-positioned photographs that skip it. |
| `cli.ts` | GPX plus a photo directory to a GeoJSON FeatureCollection. |

EXIF extraction lives in the CLI rather than the library. The library takes
timestamps and returns positions, with no opinion about where the timestamps
came from, which is what keeps it testable without files on disk.

```sh
npm test                                  # 68 tests
npm run correlate -- <track.gpx> <photo-dir> > out.geojson
```

## Gate

Reached. Every photograph from five real outings lands on the correct hike, and
the four tracks with no photographs from that date place nothing rather than
inventing a match:

| Track | Photographs placed | Offset |
|---|---|---|
| 2026-07-04 | 6 of 14 | UTC-6 |
| 2026-07-11 | 2 of 14 | UTC-6 |
| 2026-07-12 | 1 of 14 | UTC-6 |
| 2026-08-15 | 3 of 14 | UTC-6 |
| 2026-08-22 | 2 of 14 | UTC-6 |
| four other tracks | 0 of 14 | none resolved |

## What Phase 1 changed about the design

**The offset search is usually underdetermined.** A handful of photographs taken
in the middle of a long hike leave hours of slack at both ends of the activity
window, and every candidate offset inside that slack places exactly the same
photographs. The spread tiebreak cannot separate them either, because shifting
every photograph by the same amount leaves the spread unchanged. On real data,
12 to 38 of the 105 candidates tied.

Breaking that tie arbitrarily is not a rounding error. Preferring the candidate
closest to zero — the obvious way to make a tie deterministic — inferred
**UTC-3:15 for a hike in Colorado**.

So the search returns an admissible set. One member means the search determined
it. Several means a prior chooses within the set: the photographs' own
`OffsetTimeOriginal` selects, but only from candidates the track already admits,
so a camera left on the wrong zone cannot drag the answer somewhere impossible.
With no usable prior the midpoint is taken and the result is flagged `ambiguous`
with its range, which is what the offset slider is for.

A 15-minute grace period with 15-minute candidate spacing also puts a floor on
resolution: the neighbouring candidates stay admissible however well the
photographs cover the activity.

**Confidence is capped at `medium` when the offset was ambiguous.** The gap and
speed signals describe the interpolation given an offset; they say nothing about
whether that offset was determined or picked from a set of two dozen. A viewer
reads one word for both. Photographs carrying their own EXIF coordinates are
exempt, since their position never depended on the offset.

## Still outstanding

- No photograph in the fixture set falls outside its activity window, so the
  unplaced-photo path has tests but no real data behind them. This needs a
  photograph taken before the watch started, not another track.
