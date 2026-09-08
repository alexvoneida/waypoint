import type { PoolClient } from "pg";
import { withUser } from "@/lib/db";
import { loadTrackPoints } from "@/lib/track";
import { suggestTrailName, type SuggestNameResult } from "@/lib/osm-names";
import { inngest } from "./client";

interface TrailFoundedEventData {
  trailId: string;
  activityId: string;
  userId: string;
}

interface TrailNamingState {
  nameSource: "activity" | "osm" | "user";
  hasPublishedEntries: boolean;
}

async function loadActivityName(client: PoolClient, activityId: string): Promise<string> {
  const { rows } = await client.query<{ name: string }>("select name from activities where id = $1", [
    activityId,
  ]);
  return rows[0]?.name ?? "";
}

async function loadTrailNamingState(client: PoolClient, trailId: string): Promise<TrailNamingState | null> {
  const { rows } = await client.query<{ name_source: string; published_count: string }>(
    `select t.name_source,
            (select count(*) from entries e where e.trail_id = t.id and e.status = 'published') as published_count
     from trails t
     where t.id = $1`,
    [trailId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    nameSource: row.name_source as TrailNamingState["nameSource"],
    hasPublishedEntries: Number(row.published_count) > 0,
  };
}

// Same slugify used to found a trail in trail-match.ts (lowercase, hyphenated,
// ASCII-folded). Not imported from there because that function is private to
// this module's founding path; duplicating one four-line transform is
// cheaper than exporting it across an unrelated concern.
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
 * Renames a trail's slug to match a new display name, retrying with a
 * numeric suffix on a collision -- the same savepoint pattern
 * matchActivityToTrail's foundTrail uses for the same reason: trails.slug is
 * globally unique, so a retry must be able to fail just this one statement
 * without aborting the whole job.
 */
async function renameSlug(client: PoolClient, trailId: string, name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  for (;;) {
    await client.query("savepoint trail_rename");
    try {
      await client.query("update trails set slug = $2 where id = $1", [trailId, candidate]);
      await client.query("release savepoint trail_rename");
      return candidate;
    } catch (error) {
      await client.query("rollback to savepoint trail_rename");
      const pgError = error as { code?: string; constraint?: string };
      if (pgError.code === "23505" && pgError.constraint === "trails_slug_key") {
        candidate = `${base}-${suffix}`;
        suffix += 1;
        continue;
      }
      throw error;
    }
  }
}

async function applyTrailName(
  client: PoolClient,
  trailId: string,
  keepSlug: boolean,
  suggestion: SuggestNameResult,
): Promise<void> {
  // A trail with at least one published entry already has a live URL other
  // pages and outside links may point to, so its slug is frozen from here on
  // -- only the display name (and its OSM provenance) change. A trail with
  // no published entries yet is still pre-launch, so its slug can improve
  // alongside its name with nothing to break.
  if (!keepSlug) {
    await renameSlug(client, trailId, suggestion.name);
  }

  await client.query(
    `update trails
     set name = $2, name_source = 'osm', name_confidence = $3, name_candidates = $4
     where id = $1`,
    [trailId, suggestion.name, suggestion.confidence, JSON.stringify(suggestion.candidates)],
  );
}

export type TrailNameOutcome =
  | { applied: true; name: string; confidence: number }
  | { applied: false; reason: string };

/**
 * Looks up an OSM name for a newly founded trail and applies it, unless the
 * trail's name has since become a user correction (permanent, per the naming
 * spec) or no OSM candidate clears suggestTrailName's acceptance threshold --
 * in either case the activity-seeded name is left exactly as it was.
 */
export async function suggestAndApplyTrailName(
  trailId: string,
  activityId: string,
  userId: string,
): Promise<TrailNameOutcome> {
  return withUser(userId, async (client) => {
    const state = await loadTrailNamingState(client, trailId);
    if (!state) {
      return { applied: false, reason: "trail not found" };
    }
    if (state.nameSource === "user") {
      return { applied: false, reason: "name_source is user" };
    }

    const activityName = await loadActivityName(client, activityId);
    const trackPoints = await loadTrackPoints(client, activityId);
    const suggestion = await suggestTrailName(trackPoints, activityName);
    if (!suggestion) {
      return { applied: false, reason: "no acceptable OSM candidate" };
    }

    await applyTrailName(client, trailId, state.hasPublishedEntries, suggestion);
    return { applied: true, name: suggestion.name, confidence: suggestion.confidence };
  });
}

// Runs strictly after a trail is founded (trail-match.ts sends trail/founded
// only then, never for a link to an existing trail), and never inline during
// ingest: Overpass is a free, shared service whose usage policy discourages
// heavy automated querying, and its latency and availability are entirely
// outside our control. Neither belongs on the critical path of an activity
// upload.
export const trailName = inngest.createFunction(
  { id: "trail-name", retries: 3, triggers: [{ event: "trail/founded" }] },
  async ({ event, step }) => {
    const { trailId, activityId, userId } = event.data as TrailFoundedEventData;
    return step.run("suggest-name", () => suggestAndApplyTrailName(trailId, activityId, userId));
  },
);
