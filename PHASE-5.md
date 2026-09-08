# Phase 5: Strava OAuth and historical import

## Gate

**Partly proven.** The data half is proven against the real API and the real
database by `scripts/test-strava-live.mjs`; the browser half — consent screen,
callback, reconnect — is walked by hand and has been exercised once end to end
through the studio.

```
one real page of activities lands in the listing cache      72 activities
the cursor advances to the oldest activity on the page      ✔
facets come from what the account actually has              Hike, Run · 2026
an activity imports to a draft entry with a real track      ✔
the imported track reads back as ascending TrackPoints      ✔
re-importing the same activity is a no-op, not a duplicate  ✔
a re-scan does not forget what was already imported         ✔
```

Through HTTP, with a real session cookie:

```
GET  /api/strava/activities             200  72 total, facets Hike/Run · 2026
GET  /api/strava/activities?sport=Hike&year=2026
                                        200  9 of 72
GET  /studio/strava                     200  selector and athlete rendered
POST /api/strava/disconnect             200  {disconnected, revokedAtStrava}
GET  /api/strava/activities             404  no connection — cache went with it
```

## What exists

**Connect.** `/api/strava/authorize` issues a nonce bound to the session and
stored server-side; the callback consumes it by deleting it, so a replay finds
nothing and two simultaneous callbacks cannot both win. Tokens are encrypted
with AES-256-GCM before they reach the database. Every caller obtains an access
token through `getAccessToken`, which refreshes five minutes ahead of expiry and
re-encrypts in place — transparent refresh is a property of the store, not
something each call site remembers.

**List.** The backfill walks `GET /athlete/activities` newest-first into
`strava_activities`. The cursor is the oldest `start_date` written so far, which
is exactly the `before` parameter of the next page, and it is committed in the
same transaction as the page it describes. Five pages per invocation, then a
fresh event.

**Import.** Streams become the same `Track` the GPX parser produces, so nothing
downstream can tell an imported activity from an uploaded one. Each import
creates a draft entry with the track attached and no photographs. Dedupe is the
schema's `unique (user_id, source, external_id)`.

**Select.** `/studio` and `/studio/strava` are the first authenticated interface
in the app: sign in, connect, filter by sport and year, hide what is already
imported, page, select, import.

## Three findings worth keeping

**Distance must come from Strava, not from the geometry, and the difference is
large.** §5 says so, and the reason turns out to be measurable: summing a track
point to point accumulates GPS jitter with the sample rate. Across this author's
own activities a 4 s-interval track agreed with Strava to within 0.6%, but a
1 s-interval track came out **13.5% long** — 14.23 km against Strava's 12.54 km.
The first version of the importer stored the computed figure, and nothing on the
page would have revealed it: an inflated distance looks exactly like a real one.
That is the failure mode the omitted-elevation rule exists to prevent, and the
live test now asserts all four statistics equal Strava's exactly.

**A rate limit is a pause, not a failure.** Strava's short-term budget is 100
requests per 15 minutes shared across the whole application, and a 429 carries
no `Retry-After` — the window is clock-aligned, so the reset has to be computed.
It is recorded on the connection and rendered as "resumes at 14:15" in both the
panel and the selector. The listing stops at a known page and resumes there.

**`utc_offset`, never the `timezone` label.** Carried forward from Phase 0 and
now load-bearing in two places: the year filter and `occurred_on` both use the
activity's local date. Parsing the `(GMT-07:00)` prefix would put every summer
hike an hour out and file evening walks under the following day.

## Known limitations

- **The OAuth round trip has no automated test.** Consent happens in a browser
  on Strava's domain. `scripts/test-strava-live.mjs` covers everything after a
  connection exists, which is the half that can break silently; the callback's
  nonce handling is covered only by reading it.
- **Disconnect revokes the whole grant for the athlete**, which is correct and
  also means a disconnect from any account sharing that Strava athlete kills
  `STRAVA_DEV_REFRESH_TOKEN` in `.env`. Regenerate with
  `node scripts/strava-probe.mjs`.
- **The listing is a snapshot with no invalidation.** A rescan is manual. An
  activity renamed or deleted on Strava keeps its cached row until then, and a
  deleted one fails at import rather than disappearing from the list. Strava's
  webhook subscription would fix this and is not built.
- **Import does not backfill `local_zone` for GPX activities**, so `occurred_on`
  is still provisional there — the Phase 3 limitation is unchanged.
- **Sport mapping is a fixed list.** `Hike`, `Walk`, `Snowshoe` and `TrailRun`
  become `hike`; everything else is `other`. Nothing yet keeps `other` out of
  correlation, whose constants assume walking pace.
- **`scripts/test-strava-live.mjs` shares the development database** and, like
  the trail-matching tests, is not isolated in a transaction. It cleans up after
  itself by deleting its throwaway user, which cascades.
- **Camera profiles and watch-face calibration (P-5) are not in this phase.**
  Deferred to Phase 6 by decision: the schema table exists, the feature is cut
  list item 4, and it belongs next to the offset slider rather than next to
  OAuth.
- The selector polls every four seconds while a scan or import is outstanding.
  A subscription would be better and is not worth it at one user.
