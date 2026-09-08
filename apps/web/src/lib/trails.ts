import type { PoolClient } from "pg";

/** Metres. Matches the buffer already verified against the live database (see
 *  docs referenced in the Phase 4 spec); do not retune without re-deriving
 *  the fixture set that validates it. */
export const TRAIL_BUFFER_METRES = 40;
export const SAME_THRESHOLD = 0.8;
export const SUGGEST_THRESHOLD = 0.35;

export type TrailMatch = {
  trailId: string;
  scoreFwd: number;
  scoreRev: number;
  classification: "same" | "suggested" | "different";
};

/**
 * Bidirectional containment score for two geometries, each given as WKT text
 * (SRID 4326). `scoreFwd` is the fraction of `geomA` lying inside a buffered
 * `geomB`; `scoreRev` is the fraction of `geomB` lying inside a buffered
 * `geomA`. Buffering is done in geography so the buffer radius is metres
 * regardless of latitude.
 */
export async function scoreGeometryPair(
  client: PoolClient,
  geomA: string,
  geomB: string,
): Promise<{ scoreFwd: number; scoreRev: number }> {
  const { rows } = await client.query<{ score_fwd: number; score_rev: number }>(
    // ST_Force2D is load-bearing, not defensive tidying. An activity's track is
    // LineStringZM, and intersecting that with a 2D buffer fragments it into
    // hundreds of parts whose summed geography length exceeds the track's own
    // by about 1.5 percent - a containment fraction above 1.0, which is
    // meaningless and biases every pair toward merging. Measured on a real
    // 16.2 km track: 1.0152 with the Z and M ordinates, 0.9999 without.
    `with pair as (
       select
         ST_Force2D(ST_GeomFromText($1, 4326)) as a,
         ST_Force2D(ST_GeomFromText($2, 4326)) as b
     )
     select
       least(1.0, ST_Length(ST_Intersection(a, ST_Buffer(b::geography, $3)::geometry)::geography)
         / ST_Length(a::geography)) as score_fwd,
       least(1.0, ST_Length(ST_Intersection(b, ST_Buffer(a::geography, $3)::geometry)::geography)
         / ST_Length(b::geography)) as score_rev
     from pair`,
    [geomA, geomB, TRAIL_BUFFER_METRES],
  );

  const row = rows[0];
  if (!row) {
    throw new Error("scoreGeometryPair query returned no row");
  }
  return { scoreFwd: row.score_fwd, scoreRev: row.score_rev };
}

/**
 * Pure classification from the two containment scores. Both directions must
 * clear SAME_THRESHOLD for `same` -- a one-directional test would merge a
 * short spur into a long traverse it happens to share.
 */
export function classify(scoreFwd: number, scoreRev: number): TrailMatch["classification"] {
  if (scoreFwd >= SAME_THRESHOLD && scoreRev >= SAME_THRESHOLD) {
    return "same";
  }
  if (scoreFwd >= SUGGEST_THRESHOLD || scoreRev >= SUGGEST_THRESHOLD) {
    return "suggested";
  }
  return "different";
}

/**
 * Narrows the field of trails to those whose canonical geometry intersects
 * the activity's simplified track, using the GiST indexes on both columns.
 * Scoring and linking are separate concerns -- this only narrows.
 */
export async function findCandidateTrails(client: PoolClient, activityId: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `select t.id
     from trails t
     join activities a on a.id = $1
     where ST_Intersects(t.canonical_geom, a.track_simplified)`,
    [activityId],
  );
  return rows.map((row) => row.id);
}
