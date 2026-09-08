import type { NextRequest } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/http";
import { readConnection } from "@/lib/strava/connection";
import { loadListingFacets, loadListingPage } from "@/lib/strava/listing";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const querySchema = z.object({
  sport: z.string().min(1).max(40).optional(),
  year: z.coerce.number().int().min(1970).max(2200).optional(),
  unimported: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(request: NextRequest) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return jsonError(400, "Invalid query parameters", { issues: parsed.error.flatten() });
  }
  const { sport, year, unimported, limit, offset } = parsed.data;

  const result = await withUser(userId, async (client) => {
    const connection = await readConnection(client, userId);
    if (!connection) return null;

    const [page, facets] = await Promise.all([
      loadListingPage(client, userId, {
        sportType: sport,
        year,
        onlyUnimported: unimported === "true",
        limit,
        offset,
      }),
      loadListingFacets(client, userId),
    ]);
    return { connection, page, facets };
  });

  if (!result) {
    return jsonError(404, "No Strava connection for this account");
  }

  const { connection, page, facets } = result;
  return jsonOk({
    connection: {
      athleteId: connection.athleteId,
      // What the selector renders as its degraded state: 'listing' means the
      // scan is still running and the list will grow; rateLimitedUntil means
      // it is paused, and when it resumes. N-3 asks for exactly this -- a
      // rate limit that is visible rather than a list that quietly stops.
      backfillStatus: connection.backfillStatus,
      rateLimitedUntil: connection.rateLimitedUntil?.toISOString() ?? null,
      listingError: connection.listingError,
    },
    activities: page.activities,
    total: page.total,
    limit,
    offset,
    facets,
  });
}
