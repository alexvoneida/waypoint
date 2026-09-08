import { withUser } from "@/lib/db";
import { listActivities, StravaRateLimitError, type StravaSummaryActivity } from "@/lib/strava/api";
import { getAccessToken } from "@/lib/strava/connection";
import { inngest } from "./client";

interface BackfillEventData {
  userId: string;
}

const PER_PAGE = 100;

// Pages fetched per invocation, not per backfill. Strava's short-term limit
// is 100 requests per 15 minutes shared across the whole application, so a
// 400-activity account is walked over several invocations rather than in one
// burst that could starve every other user's import.
const PAGES_PER_RUN = 5;

/**
 * Lists an athlete's historical activities into `strava_activities`, so the
 * N-2 selector reads a cached table rather than spending the rate limit on
 * every scroll.
 *
 * Resumable by construction. Activities come back newest-first, so the
 * oldest `start_date` written so far is exactly the `before` parameter the
 * next page needs; that cursor is committed with the page it describes, and
 * each page is its own Inngest step. A run that dies -- rate limit, timeout,
 * deploy -- resumes at the first page it had not finished, never from the
 * beginning. This is the difference §6 draws between N-2 working and N-2
 * timing out on an account with 400 activities.
 */
export const stravaBackfillList = inngest.createFunction(
  {
    id: "strava-backfill-list",
    retries: 3,
    // One listing per user at a time. Two concurrent runs would interleave
    // their cursor writes and skip pages between them.
    concurrency: { key: "event.data.userId", limit: 1 },
    triggers: [{ event: "strava/backfill.requested" }],
  },
  async ({ event, step }) => {
    const { userId } = event.data as BackfillEventData;

    const start = await step.run("begin-listing", () =>
      withUser(userId, async (client) => {
        const { rows } = await client.query<{ backfill_cursor: Date | null }>(
          `update strava_connections
             set backfill_status = 'listing', rate_limited_until = null, listing_error = null
           where user_id = $1
           returning backfill_cursor`,
          [userId],
        );
        return { cursor: rows[0]?.backfill_cursor ?? null, connected: rows.length > 0 };
      }),
    );

    if (!start.connected) {
      // Disconnected between the event being sent and this run starting.
      // Nothing to list, and nothing to report as an error either.
      return { listed: 0, complete: true, connected: false };
    }

    let cursor = start.cursor ? new Date(start.cursor) : null;
    let listed = 0;

    for (let page = 0; page < PAGES_PER_RUN; page += 1) {
      const before = cursor;
      const outcome = await step.run(`list-page-${page}`, () => fetchAndStorePage(userId, before));

      if (outcome.rateLimited) {
        // Not a step failure: the work stopped for a stated reason at a known
        // point, and the studio can say when it resumes. Retrying inside this
        // run would burn the remaining budget against a closed window.
        return { listed, complete: false, rateLimitedUntil: outcome.rateLimitedUntil };
      }

      listed += outcome.count;
      if (outcome.count < PER_PAGE) {
        await step.run("finish-listing", () => markStatus(userId, "ready"));
        return { listed, complete: true };
      }
      cursor = outcome.oldestStartDate ? new Date(outcome.oldestStartDate) : null;
      if (!cursor) {
        // A full page whose activities carried no usable start date would
        // otherwise re-request the same page forever.
        await step.run("finish-listing", () => markStatus(userId, "ready"));
        return { listed, complete: true };
      }
    }

    // Budget for this invocation is spent but the scan is not finished. The
    // status stays 'listing' and a fresh event resumes from the cursor.
    await step.sendEvent("continue-listing", {
      name: "strava/backfill.requested",
      data: { userId },
    });
    return { listed, complete: false };
  },
);

interface PageOutcome {
  count: number;
  oldestStartDate: string | null;
  rateLimited: boolean;
  rateLimitedUntil: string | null;
}

async function fetchAndStorePage(userId: string, before: Date | null): Promise<PageOutcome> {
  let activities: StravaSummaryActivity[];
  try {
    const accessToken = await withUser(userId, (client) => getAccessToken(client, userId));
    if (!accessToken) {
      return { count: 0, oldestStartDate: null, rateLimited: false, rateLimitedUntil: null };
    }
    activities = await listActivities(accessToken, {
      before: before ?? undefined,
      perPage: PER_PAGE,
    });
  } catch (error) {
    if (error instanceof StravaRateLimitError) {
      await withUser(userId, (client) =>
        client.query(`update strava_connections set rate_limited_until = $2 where user_id = $1`, [
          userId,
          error.resetAt,
        ]),
      );
      return {
        count: 0,
        oldestStartDate: null,
        rateLimited: true,
        rateLimitedUntil: error.resetAt.toISOString(),
      };
    }
    // The stored message is deliberately generic: Strava's own error text can
    // name the application's client_id, and this column is rendered in the
    // studio. The detail goes to the server log.
    console.error(`Strava listing failed for ${userId}:`, error);
    await withUser(userId, (client) =>
      client.query(`update strava_connections set listing_error = $2 where user_id = $1`, [
        userId,
        "Strava could not be reached while listing activities.",
      ]),
    );
    throw error;
  }

  if (activities.length === 0) {
    return { count: 0, oldestStartDate: null, rateLimited: false, rateLimitedUntil: null };
  }

  const oldest = activities.reduce((earliest, activity) =>
    activity.startDate < earliest.startDate ? activity : earliest,
  );

  // The page and its cursor are written in one transaction, so a cursor never
  // claims a page that was not stored.
  await withUser(userId, async (client) => {
    for (const activity of activities) {
      await upsertListingRow(client, userId, activity);
    }
    await client.query(`update strava_connections set backfill_cursor = $2 where user_id = $1`, [
      userId,
      oldest.startDate,
    ]);
  });

  return {
    count: activities.length,
    oldestStartDate: oldest.startDate.toISOString(),
    rateLimited: false,
    rateLimitedUntil: null,
  };
}

type QueryableClient = { query: (text: string, values: unknown[]) => Promise<unknown> };

async function upsertListingRow(
  client: QueryableClient,
  userId: string,
  activity: StravaSummaryActivity,
): Promise<void> {
  // Renames and edited distances are picked up on a re-scan, but activity_id
  // and imported_at are left alone: a re-listing must never forget that
  // something was already imported.
  await client.query(
    `insert into strava_activities
       (user_id, strava_id, name, sport_type, start_date, utc_offset_s, timezone,
        distance_m, ascent_m, moving_s, elapsed_s)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (user_id, strava_id) do update set
       name         = excluded.name,
       sport_type   = excluded.sport_type,
       start_date   = excluded.start_date,
       utc_offset_s = excluded.utc_offset_s,
       timezone     = excluded.timezone,
       distance_m   = excluded.distance_m,
       ascent_m     = excluded.ascent_m,
       moving_s     = excluded.moving_s,
       elapsed_s    = excluded.elapsed_s,
       updated_at   = now()`,
    [
      userId,
      activity.id,
      activity.name,
      activity.sportType,
      activity.startDate,
      activity.utcOffsetSeconds,
      activity.timezone,
      activity.distanceM,
      activity.ascentM,
      activity.movingS,
      activity.elapsedS,
    ],
  );
}

async function markStatus(userId: string, status: "ready" | "done"): Promise<void> {
  await withUser(userId, (client) =>
    client.query(
      `update strava_connections
         set backfill_status = $2, rate_limited_until = null, listing_error = null
       where user_id = $1`,
      [userId, status],
    ),
  );
}
