import type { NextRequest } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError, jsonOk, parseBody } from "@/lib/http";
import { inngest } from "@/lib/jobs/client";
import { setBackfillStatus } from "@/lib/strava/connection";

const MAX_PER_REQUEST = 50;

const bodySchema = z.object({
  // Strings, not numbers: Strava activity ids exceed what a JavaScript number
  // represents exactly, and JSON.parse would round the tail off some of them
  // before any validation could notice.
  stravaIds: z.array(z.string().regex(/^\d+$/)).min(1).max(MAX_PER_REQUEST),
});

export async function POST(request: NextRequest) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }

  const parsed = await parseBody(request, bodySchema);
  if (!parsed.ok) return parsed.response;
  const requested = [...new Set(parsed.data.stravaIds)];

  // Ids are checked against this account's own cached listing rather than
  // taken on trust. RLS already scopes the read, so an id belonging to
  // someone else simply does not come back -- and an id that was never listed
  // at all is rejected here rather than becoming a job that fails.
  const rows = await withUser(userId, async (client) => {
    const { rows } = await client.query<{ strava_id: string; activity_id: string | null }>(
      `select strava_id, activity_id from strava_activities
       where user_id = $1 and strava_id = any($2::bigint[])`,
      [userId, requested],
    );
    return rows;
  });

  const known = new Map(rows.map((row) => [String(row.strava_id), row.activity_id]));
  const unknown = requested.filter((id) => !known.has(id));
  const alreadyImported = requested.filter((id) => known.get(id));
  const toImport = requested.filter((id) => known.has(id) && !known.get(id));

  if (toImport.length === 0) {
    return jsonOk({ queued: 0, alreadyImported, unknown });
  }

  await withUser(userId, (client) => setBackfillStatus(client, userId, "importing"));

  // One event per activity, so a failure costs that activity rather than the
  // selection. Enqueued before the response so the caller learns immediately
  // if the queue is unreachable -- unlike the fire-and-forget sends elsewhere,
  // nothing is persisted here that failing loudly would orphan.
  //
  // Caught rather than thrown: an unreachable queue is a stated, retriable
  // condition, and the selector can say so. Letting it escape produces a bare
  // 500 with an empty body, which is the same outcome dressed as a crash.
  try {
    await inngest.send(
      toImport.map((stravaId) => ({
        name: "strava/import.activity",
        data: { userId, stravaId },
      })),
    );
  } catch (error) {
    console.error(`failed to enqueue strava/import.activity for ${userId}:`, error);
    await withUser(userId, (client) => setBackfillStatus(client, userId, "ready"));
    return jsonError(503, "The import queue is unavailable. Nothing was imported; try again.");
  }

  return jsonOk({ queued: toImport.length, alreadyImported, unknown }, { status: 202 });
}
