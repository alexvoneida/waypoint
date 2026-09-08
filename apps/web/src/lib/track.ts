import type { PoolClient } from "pg";
import type { Track, TrackPoint } from "@waypoint/correlation";

/**
 * Builds the `LINESTRING ZM(...)` WKT literal `ST_GeomFromText` expects for
 * `activities.track`. Points with no recorded elevation get 0 for Z -- there
 * is no "no value" in a WKT coordinate, so this table cannot represent
 * elevation nullability the way `TrackPoint.ele` can. The correlation
 * engine's own in-memory `Track` is what carries the real null through a
 * request; once a track is persisted here, a formerly-null elevation reads
 * back as 0, not as absent.
 */
export function buildTrackWkt(points: TrackPoint[]): string {
  const coordinates = points
    .map((point) => `${point.lon} ${point.lat} ${point.ele ?? 0} ${point.time}`)
    .join(", ");
  return `LINESTRING ZM(${coordinates})`;
}

export interface InsertActivityInput {
  name: string;
  source: "gpx" | "fit" | "strava";
  track: Track;
}

/**
 * Inserts an activity and returns its id. `track_simplified`, `distance_m`,
 * `started_at`, `ended_at` and `elapsed_s` are all computed in SQL from the
 * same WKT the caller supplies, so there is exactly one geometry parse and no
 * chance of the simplified line or the distance drifting from the stored
 * track.
 *
 * `ascent_m` and `moving_s` are inserted as NULL, always, for GPX. This is
 * load-bearing (see 0002_schema.sql's comment on `activities.ascent_m`): these
 * columns hold Strava's own reported figures or nothing. A GPX track has
 * enough samples to make a naive positive-elevation-delta sum tempting, but
 * that sum overstates real gain badly on noisy consumer GPS traces, and a
 * silently-wrong number is worse than an honest blank. Do not compute a
 * fallback here.
 */
export async function insertActivity(
  client: PoolClient,
  userId: string,
  input: InsertActivityInput,
): Promise<string> {
  const { name, source, track } = input;
  const wkt = buildTrackWkt(track.points);
  const elapsedSeconds = track.endedAt - track.startedAt;

  const { rows } = await client.query<{ id: string }>(
    `insert into activities
       (user_id, source, name, started_at, ended_at, track, track_simplified,
        distance_m, ascent_m, moving_s, elapsed_s)
     values
       ($1, $2, $3, to_timestamp($4), to_timestamp($5),
        ST_GeomFromText($6, 4326),
        ST_SimplifyPreserveTopology(ST_Force2D(ST_GeomFromText($6, 4326)), 0.0001),
        ST_Length(ST_GeomFromText($6, 4326)::geography),
        null, null, $7)
     returning id`,
    [userId, source, name, track.startedAt, track.endedAt, wkt, elapsedSeconds],
  );

  const id = rows[0]?.id;
  if (!id) {
    throw new Error("activity insert returned no id");
  }
  return id;
}

interface TrackPointRow {
  lon: number;
  lat: number;
  ele: number;
  epoch: number;
}

/**
 * Reads an activity's full track back out as `TrackPoint[]`, for handing to
 * `correlate`. Uses `ST_DumpPoints` rather than `ST_AsGeoJSON`: dumping keeps
 * M (epoch seconds) attached to each point via `ST_M`, where GeoJSON has no
 * slot for a fourth ordinate at all and would need a second query just to
 * recover time.
 *
 * Verified by round-tripping a real GPX fixture through `insertActivity` and
 * this function in a scratch script and diffing the two `TrackPoint[]`
 * arrays: every `lon`/`lat`/`time` came back exactly equal to the source
 * (floating-point WKT text round-trips exactly through PostGIS's parser at
 * the precision GPX uses), and every `ele` came back equal to the source for
 * points that had one, and 0 for points that had none -- the expected lossy
 * behaviour documented on `buildTrackWkt` above, not a bug.
 */
export async function loadTrackPoints(client: PoolClient, activityId: string): Promise<TrackPoint[]> {
  const { rows } = await client.query<TrackPointRow>(
    `select
       ST_X((dp).geom) as lon,
       ST_Y((dp).geom) as lat,
       ST_Z((dp).geom) as ele,
       ST_M((dp).geom) as epoch
     from (
       select ST_DumpPoints(track) as dp
       from activities
       where id = $1
     ) points
     order by (dp).path`,
    [activityId],
  );

  return rows.map((row) => ({
    lon: row.lon,
    lat: row.lat,
    ele: row.ele,
    time: Math.round(row.epoch),
  }));
}
