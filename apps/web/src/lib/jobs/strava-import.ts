import type { PoolClient } from "pg";
import { withUser } from "@/lib/db";
import { insertActivity } from "@/lib/track";
import { getStreams, StravaRateLimitError, type StravaSummaryActivity } from "@/lib/strava/api";
import { getAccessToken } from "@/lib/strava/connection";
import { streamsToTrack, StravaImportError, toSport } from "@/lib/strava/import";
import { inngest } from "./client";

interface ImportEventData {
  userId: string;
  stravaId: string;
}

interface CachedRow {
  strava_id: string;
  name: string;
  sport_type: string;
  start_date: Date;
  utc_offset_s: number;
  timezone: string | null;
  distance_m: number;
  ascent_m: number | null;
  moving_s: number | null;
  elapsed_s: number;
  activity_id: string | null;
}

/**
 * Imports one Strava activity as a draft entry with its track attached and no
 * photographs yet (N-2), which is the state the correlation review step
 * expects to find when photographs are uploaded against it later.
 *
 * One activity per invocation, fanned out by POST /api/strava/import. A
 * selection of forty activities is forty runs, so one failure -- a missing
 * stream, a rate limit -- costs that activity and not the batch.
 */
export const stravaImportActivity = inngest.createFunction(
  {
    id: "strava-import-activity",
    retries: 3,
    // Streams are one request each against a budget shared by the whole
    // application. Four at a time imports a selection promptly without
    // emptying the 15-minute window in one go.
    concurrency: { limit: 4 },
    triggers: [{ event: "strava/import.activity" }],
  },
  async ({ event, step }) => {
    const { userId, stravaId } = event.data as ImportEventData;

    return step.run("import-activity", async () => {
      try {
        return await importOne(userId, stravaId);
      } catch (error) {
        if (error instanceof StravaRateLimitError) {
          await recordImportError(
            userId,
            stravaId,
            `Strava's rate limit was reached. This activity will import after ${error.resetAt.toISOString()}.`,
          );
          // Rethrown so Inngest's own backoff retries it, rather than
          // swallowing it into a row that reads "failed" for a reason that
          // resolves itself in fifteen minutes.
          throw error;
        }
        const message =
          error instanceof StravaImportError
            ? error.message
            : "the activity could not be imported from Strava";
        console.error(`Strava import failed for ${stravaId} (user ${userId}):`, error);
        await recordImportError(userId, stravaId, message);
        throw error;
      }
    });
  },
);

/** Exported for scripts/test-strava-live.mjs; see the note in strava-backfill.ts. */
export async function importOne(userId: string, stravaId: string) {
  const cached = await withUser(userId, (client) => readCachedRow(client, userId, stravaId));
  if (!cached) {
    throw new StravaImportError("this activity is not in the cached listing");
  }
  // Already imported. Not an error: a double-clicked import, a retried step,
  // or a re-selected row all land here, and the schema's unique
  // (user_id, source, external_id) means a second insert could not have
  // succeeded anyway.
  if (cached.activity_id) {
    return { imported: false, reason: "already-imported" as const, activityId: cached.activity_id };
  }

  const accessToken = await withUser(userId, (client) => getAccessToken(client, userId));
  if (!accessToken) {
    throw new StravaImportError("this account is not connected to Strava");
  }

  const summary = toSummary(cached);
  const streams = await getStreams(accessToken, Number(stravaId));
  if (!streams) {
    // Indoor and manually-entered activities have no position stream. Nothing
    // is wrong; there is simply nothing to place photographs on.
    throw new StravaImportError("this activity has no GPS track to import");
  }

  const track = streamsToTrack(summary, streams);

  const result = await withUser(userId, async (client) => {
    const activityId = await insertActivity(client, userId, {
      name: summary.name,
      source: "strava",
      externalId: stravaId,
      localZone: summary.timezone ?? undefined,
      sport: toSport(summary.sportType),
      // §5's statistics table: when the activity came from Strava, Strava's
      // figures are authoritative and stored verbatim -- all four of them,
      // not just the two a GPX cannot supply. Distance especially: summing a
      // 1 Hz track point to point measured 13.5% longer than Strava's own
      // figure on a real hike, because GPS jitter accumulates with sample
      // rate. The computed value is right for a GPX and wrong here.
      reportedAscentM: summary.ascentM,
      reportedMovingS: summary.movingS,
      reportedDistanceM: summary.distanceM,
      reportedElapsedS: summary.elapsedS,
      track,
    });

    // The draft the author will attach photographs to. `occurred_on` uses the
    // activity's *local* date via utc_offset -- which the GPX path cannot do,
    // because a GPX file does not carry one. An 8pm summer hike in Denver is
    // 02:00 UTC the next day, and filing it under tomorrow is wrong on the
    // entry page and wrong in the trail page's date grouping.
    const { rows } = await client.query<{ id: string }>(
      `insert into entries (user_id, activity_id, title, occurred_on, status, slug)
       values ($1, $2, $3, ($4::timestamptz + make_interval(secs => $5::int))::date, 'draft', null)
       returning id`,
      [userId, activityId, summary.name, cached.start_date, cached.utc_offset_s],
    );
    const entryId = rows[0]?.id;
    if (!entryId) throw new Error("entry insert returned no id");

    await client.query(
      `update strava_activities
         set activity_id = $3, imported_at = now(), import_error = null
       where user_id = $1 and strava_id = $2`,
      [userId, stravaId, activityId],
    );

    return { activityId, entryId };
  });

  // After the transaction commits, matching POST /api/activities: trail
  // matching needs the activity to be visible to another connection, and a
  // failed enqueue must not unwind an import that otherwise succeeded.
  await inngest
    .send({ name: "activity/created", data: { activityId: result.activityId, userId } })
    .catch((error: unknown) => {
      console.error(`failed to enqueue activity/created for ${result.activityId}:`, error);
    });

  return { imported: true, ...result, warnings: track.warnings };
}

async function readCachedRow(
  client: PoolClient,
  userId: string,
  stravaId: string,
): Promise<CachedRow | null> {
  const { rows } = await client.query<CachedRow>(
    `select strava_id, name, sport_type, start_date, utc_offset_s, timezone,
            distance_m, ascent_m, moving_s, elapsed_s, activity_id
     from strava_activities
     where user_id = $1 and strava_id = $2`,
    [userId, stravaId],
  );
  return rows[0] ?? null;
}

function toSummary(row: CachedRow): StravaSummaryActivity {
  return {
    id: Number(row.strava_id),
    name: row.name,
    sportType: row.sport_type,
    startDate: row.start_date,
    utcOffsetSeconds: row.utc_offset_s,
    timezone: row.timezone,
    distanceM: row.distance_m,
    ascentM: row.ascent_m,
    movingS: row.moving_s,
    elapsedS: row.elapsed_s,
  };
}

async function recordImportError(userId: string, stravaId: string, message: string): Promise<void> {
  // Best-effort: this runs while another failure is already unwinding, and a
  // write failing here must not replace that error with this one.
  await withUser(userId, (client) =>
    client.query(
      `update strava_activities set import_error = $3 where user_id = $1 and strava_id = $2`,
      [userId, stravaId, message],
    ),
  ).catch((error: unknown) => {
    console.error(`could not record import error for ${stravaId}:`, error);
  });
}
