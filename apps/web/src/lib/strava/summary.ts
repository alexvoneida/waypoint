import { withUser } from "@/lib/db";
import { readConnection } from "./connection";
import type { ConnectionSummary } from "@/app/studio/strava-panel";

/**
 * The connection as the studio renders it: the row plus the two counts that
 * say whether the backfill has anything to show yet. Server-side only -- the
 * pages read this directly rather than fetching their own endpoint.
 */
export async function loadConnectionSummary(userId: string): Promise<ConnectionSummary | null> {
  return withUser(userId, async (client) => {
    const connection = await readConnection(client, userId);
    if (!connection) return null;

    // count(activity_id) counts non-null values, which is exactly "how many
    // listed activities have been imported".
    const { rows } = await client.query<{ listed: string; imported: string }>(
      `select count(*) as listed, count(activity_id) as imported
       from strava_activities
       where user_id = $1`,
      [userId],
    );

    return {
      athleteId: connection.athleteId,
      backfillStatus: connection.backfillStatus,
      rateLimitedUntil: connection.rateLimitedUntil?.toISOString() ?? null,
      listingError: connection.listingError,
      listedCount: Number(rows[0]?.listed ?? 0),
      importedCount: Number(rows[0]?.imported ?? 0),
    };
  });
}
