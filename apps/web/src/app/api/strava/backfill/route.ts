import type { NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/http";
import { inngest } from "@/lib/jobs/client";
import { readConnection } from "@/lib/strava/connection";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Re-runs the historical scan. The callback enqueues it once on connect; this
 * exists for the two cases that leaves out -- a scan that stopped on a rate
 * limit or a network failure, and an account that has been out walking since
 * it last looked.
 */
export async function POST(request: NextRequest) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }

  const connection = await withUser(userId, (client) => readConnection(client, userId));
  if (!connection) {
    return jsonError(404, "No Strava connection for this account");
  }

  // A person clicking "rescan" repeatedly should not be the thing that spends
  // the application's shared 15-minute budget. The job's own per-user
  // concurrency limit stops two scans overlapping; this stops the queue
  // filling with runs that would each start by re-listing the same pages.
  const limit = checkRateLimit(`strava:backfill:${userId}`, {
    limit: 3,
    windowMs: 15 * 60 * 1000,
  });
  if (!limit.allowed) {
    return jsonError(429, "A rescan was requested recently. Try again shortly.", {
      retryAfterSeconds: limit.retryAfterSeconds,
    });
  }

  // From the top: a rescan exists to pick up activities newer than anything
  // already listed, and those sit before the stored cursor, which points at
  // the oldest page reached. Already-cached rows are upserted, and the
  // imported ones keep their activity_id, so re-listing costs requests and
  // changes nothing else.
  await withUser(userId, (client) =>
    client.query(
      `update strava_connections
         set backfill_cursor = null, backfill_status = 'listing',
             rate_limited_until = null, listing_error = null
       where user_id = $1`,
      [userId],
    ),
  );

  // As in POST /api/strava/import: an unreachable queue is reported as such
  // rather than escaping as a bare 500. The status is put back so the studio
  // does not sit on "listing" for a scan that was never queued.
  try {
    await inngest.send({ name: "strava/backfill.requested", data: { userId } });
  } catch (error) {
    console.error(`failed to enqueue strava/backfill.requested for ${userId}:`, error);
    await withUser(userId, (client) =>
      client.query(
        `update strava_connections set backfill_status = $2 where user_id = $1`,
        [userId, connection.backfillStatus],
      ),
    );
    return jsonError(503, "The listing queue is unavailable. Try again in a moment.");
  }

  return jsonOk({ status: "listing" });
}
