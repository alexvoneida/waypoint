# Phase 4: Trail clustering and discovery

## Gate

Reached, and provable before any interface existed. Two visits to one trail
cluster automatically; two different trails from one parking lot do not.

```
case                 expected   fwd      rev      verdict
jitter               same       0.998    1.000    same
reversed             same       0.998    0.998    same
out-and-back         same       0.999    0.996    same
prefix               suggested  0.999    0.603    suggested
shared-trailhead     different  0.020    0.011    different
distinct             different  0.000    0.000    different
```

## What exists

Clustering scores containment in both directions inside a 40 m buffer, narrowed
first by the GiST index. Both directions above 0.80 links automatically; between
0.35 and 0.80 records a suggestion without applying it; below founds a new
trail. A trail keeps its longest linked track as canonical geometry, and only
automatic and confirmed links feed that, so a suggestion cannot move a trail.

Names come from OpenStreetMap where it has them, weighted by the activity's own
title. Four of the author's five tested routes resolved correctly; the fifth, in
Guatemala, has no named ways in OSM at all and keeps its activity name. A name
the author corrects is never overwritten, and a trail with published entries
keeps its slug so improving a name cannot break a shared link.

Three page types: the trail page with overlaid tracks, visits by date and a
season strip; discovery, strictly reverse-chronological with no ranking; and
profiles, whose header stays public even when the account is private.

## Two findings worth keeping

**The prefix case is `suggested`, not `same`, and that is correct.** A track
truncated to 60% scores 0.999 one way and 0.603 the other, by construction. The
fixture's expected label was wrong, not the threshold. Widening the threshold
far enough to merge a summit push into the longer traverse would also merge two
different trails leaving one trailhead - which is the case the shared-trailhead
fixture exists to catch.

**Scoring must force geometry to two dimensions first.** An activity's track is
`LineStringZM`, and intersecting that with a planar buffer fragments it into
hundreds of pieces whose summed length exceeds the track's own by about 1.5%,
producing a containment fraction above 1.0. Measured: 1.0152 with the Z and M
ordinates, 0.9999 without. Every score was biased toward merging, worst exactly
at the threshold. The fixture suite could not have caught this - it parses GPX
into plain 2D geometry, and only real database tracks carry Z and M.

## Known limitations

- **The trail page does not scale to dozens of visits.** Each visit's simplified
  track is about 24 KB of GeoJSON, and neither coarser simplification (24 KB to
  16 KB) nor fewer coordinate decimals (24 KB to 22 KB) helps much, because the
  shape genuinely needs its vertices. Twenty visits would ship half a megabyte.
  Overlaid tracks need capping or paging before a trail gets popular.
- **The trail-matching tests share a mutable development database** and are
  order-dependent: unrelated trails left behind by other work can appear as
  candidates and fail an assertion. They pass consistently against a clean
  database. A dedicated test database, or a transaction rolled back per test,
  is the fix.
- Suggested links are recorded but there is no interface to confirm or reject
  one; that belongs with the studio.
- Season strips aggregate by month across all years, so two Julys in different
  years light the same mark.
