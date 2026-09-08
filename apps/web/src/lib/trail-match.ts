import type { PoolClient } from "pg";
import { classify, findCandidateTrails, scoreGeometryPair, type TrailMatch } from "@/lib/trails";

interface ActivityForMatch {
  name: string;
  trackWkt: string;
}

async function loadActivityForMatch(client: PoolClient, activityId: string): Promise<ActivityForMatch> {
  const { rows } = await client.query<{ name: string; track_wkt: string }>(
    "select name, ST_AsText(track_simplified) as track_wkt from activities where id = $1",
    [activityId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`activity not found: ${activityId}`);
  }
  return { name: row.name, trackWkt: row.track_wkt };
}

async function loadTrailCanonicalWkt(client: PoolClient, trailId: string): Promise<string> {
  const { rows } = await client.query<{ wkt: string }>(
    "select ST_AsText(canonical_geom) as wkt from trails where id = $1",
    [trailId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`trail not found: ${trailId}`);
  }
  return row.wkt;
}

async function insertTrailLink(
  client: PoolClient,
  trailId: string,
  activityId: string,
  scoreFwd: number,
  scoreRev: number,
  status: "auto" | "suggested",
): Promise<void> {
  // trail_links's primary key is (trail_id, activity_id): ON CONFLICT DO
  // NOTHING is what makes re-running matchActivityToTrail for the same
  // activity idempotent instead of erroring or duplicating rows.
  await client.query(
    `insert into trail_links (trail_id, activity_id, score_fwd, score_rev, status)
     values ($1, $2, $3, $4, $5)
     on conflict (trail_id, activity_id) do nothing`,
    [trailId, activityId, scoreFwd, scoreRev, status],
  );
}

// Lowercase, hyphenated, ASCII-folded -- the same transform as the entry-slug
// generator in the publish route, applied here to a trail name instead of an
// entry title. Not shared as a utility because the two dedupe against
// different uniqueness scopes (global on trails.slug, per-user on
// entries.slug) and pulling that apart is not worth it for one function.
function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "trail";
}

/**
 * Founds a new trail from an activity that matched nothing existing, and
 * links that activity to it as the founding, 'auto' link. A savepoint wraps
 * each slug attempt so a collision on trails.slug (global, unlike an entry's
 * per-user slug) can retry with a numeric suffix without aborting the whole
 * transaction, exactly as publishWithUniqueSlug does for entries.
 */
async function foundTrail(
  client: PoolClient,
  activityId: string,
  name: string,
  trackWkt: string,
): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  let trailId: string | undefined;

  for (;;) {
    await client.query("savepoint found_trail");
    try {
      const { rows } = await client.query<{ id: string }>(
        `insert into trails (slug, name, canonical_geom, centroid)
         values ($1, $2, ST_GeomFromText($3, 4326), ST_Centroid(ST_GeomFromText($3, 4326))::geography)
         returning id`,
        [candidate, name, trackWkt],
      );
      trailId = rows[0]?.id;
      await client.query("release savepoint found_trail");
      break;
    } catch (error) {
      await client.query("rollback to savepoint found_trail");
      const pgError = error as { code?: string; constraint?: string };
      if (pgError.code === "23505" && pgError.constraint === "trails_slug_key") {
        candidate = `${base}-${suffix}`;
        suffix += 1;
        continue;
      }
      throw error;
    }
  }

  if (!trailId) {
    throw new Error("trail insert returned no id");
  }

  await insertTrailLink(client, trailId, activityId, 1, 1, "auto");
  await client.query("update entries set trail_id = $1 where activity_id = $2", [trailId, activityId]);
  return trailId;
}

/**
 * Recomputes a trail's canonical_geom (and centroid) as the longest track
 * among its 'auto' and 'confirmed' links. Never averages: averaging distinct
 * GPS tracks produces geometry that matches nothing an actual hiker walked,
 * where the longest single track is at least a real path someone recorded.
 * 'suggested' links are excluded because a suggestion has not been applied
 * yet (that is the whole point of the status) and 'rejected' links should
 * never have counted in the first place.
 */
async function updateCanonicalGeometry(client: PoolClient, trailId: string): Promise<void> {
  await client.query(
    `with longest as (
       select a.track_simplified as geom
       from trail_links tl
       join activities a on a.id = tl.activity_id
       where tl.trail_id = $1 and tl.status in ('auto', 'confirmed')
       order by ST_Length(a.track_simplified::geography) desc
       limit 1
     )
     update trails
     set canonical_geom = longest.geom,
         centroid = ST_Centroid(longest.geom)::geography
     from longest
     where trails.id = $1`,
    [trailId],
  );
}

export type MatchActivityOutcome = { trailId: string; classification: "auto" | "founded" };

/**
 * Links an activity to a trail, or founds one, and keeps that trail's
 * canonical geometry and entry linkage in sync. Idempotent for the same
 * activity: trail_links' primary key absorbs a repeat 'auto'/'suggested'
 * insert, entries.trail_id is set to the same value again, and re-founding
 * cannot happen because a founded trail's own canonical_geom is this
 * activity's track and so is found as its own 'same' candidate next time.
 */
export async function matchActivityToTrail(
  client: PoolClient,
  activityId: string,
): Promise<MatchActivityOutcome> {
  const activity = await loadActivityForMatch(client, activityId);
  const candidateIds = await findCandidateTrails(client, activityId);

  const scored: TrailMatch[] = [];
  for (const trailId of candidateIds) {
    const trailWkt = await loadTrailCanonicalWkt(client, trailId);
    const { scoreFwd, scoreRev } = await scoreGeometryPair(client, activity.trackWkt, trailWkt);
    scored.push({ trailId, scoreFwd, scoreRev, classification: classify(scoreFwd, scoreRev) });
  }

  const sameMatches = scored.filter((match) => match.classification === "same");
  const suggestedMatches = scored.filter((match) => match.classification === "suggested");

  let winnerId: string;
  let classification: MatchActivityOutcome["classification"];

  if (sameMatches.length > 0) {
    // Best `same` match wins by combined score -- several trails classifying
    // as `same` for one activity should be rare, but when it happens the
    // closer overall fit is the one this activity actually belongs to.
    const winner = sameMatches.reduce((best, current) =>
      current.scoreFwd + current.scoreRev > best.scoreFwd + best.scoreRev ? current : best,
    );
    await insertTrailLink(client, winner.trailId, activityId, winner.scoreFwd, winner.scoreRev, "auto");
    await client.query("update entries set trail_id = $1 where activity_id = $2", [
      winner.trailId,
      activityId,
    ]);
    winnerId = winner.trailId;
    classification = "auto";
  } else {
    winnerId = await foundTrail(client, activityId, activity.name, activity.trackWkt);
    classification = "founded";
  }

  for (const suggestion of suggestedMatches) {
    await insertTrailLink(
      client,
      suggestion.trailId,
      activityId,
      suggestion.scoreFwd,
      suggestion.scoreRev,
      "suggested",
    );
  }

  await updateCanonicalGeometry(client, winnerId);

  return { trailId: winnerId, classification };
}

/** Recomputes public_entry_count from entries visible through visible_entries
 *  -- the same public/private resolution every other public read goes
 *  through, so a trail's count never counts a draft or a private account's
 *  entry. */
export async function recountTrailEntries(client: PoolClient, trailId: string): Promise<void> {
  await client.query(
    `update trails
     set public_entry_count = (select count(*) from visible_entries where trail_id = $1)
     where id = $1`,
    [trailId],
  );
}
