import type { NextRequest } from "next/server";
import { GpxParseError, parseGpx, type Track } from "@waypoint/correlation";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/http";
import { inngest } from "@/lib/jobs/client";
import { insertActivity } from "@/lib/track";

// Above this, a GPX upload is rejected outright rather than accepted. §7
// specifies enqueueing large tracks for background parsing instead of making
// the request wait (or fail) on file size; that queue does not exist yet, so
// this is a deliberate deferral to a later phase, not an oversight.
const MAX_GPX_BYTES = 5 * 1024 * 1024;

function extractGpxName(xml: string): string | null {
  // The first <name> element in document order, namespace prefix and all.
  // GPX files from this product's own strava-to-gpx.mjs (and most exports)
  // carry the same name on <metadata><name> and <trk><name>, so there is no
  // real ambiguity to resolve between the two -- taking whichever appears
  // first avoids a second, more specific pass for no practical gain.
  const match = /<(?:\w+:)?name\b[^>]*>([^<]*)<\/(?:\w+:)?name>/.exec(xml);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

function deriveActivityName(xml: string, filename: string | null, track: Track): string {
  const gpxName = extractGpxName(xml);
  if (gpxName) return gpxName;

  if (filename) {
    const stem = filename.replace(/\.[^.]+$/, "").trim();
    if (stem) return stem;
  }

  const date = new Date(track.startedAt * 1000).toISOString().slice(0, 10);
  return `Hike on ${date}`;
}

async function readGpxFromRequest(
  request: NextRequest,
): Promise<{ xml: string; filename: string | null } | { error: ReturnType<typeof jsonError> }> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return { error: jsonError(400, "Multipart upload must include a 'file' field") };
    }
    if (file.size > MAX_GPX_BYTES) {
      return { error: jsonError(413, "GPX file exceeds the 5 MB limit") };
    }
    return { xml: await file.text(), filename: file instanceof File ? file.name : null };
  }

  if (
    contentType.includes("gpx+xml") ||
    contentType.includes("text/xml") ||
    contentType.includes("application/xml")
  ) {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_GPX_BYTES) {
      return { error: jsonError(413, "GPX file exceeds the 5 MB limit") };
    }
    return { xml: Buffer.from(bytes).toString("utf8"), filename: null };
  }

  return {
    error: jsonError(
      415,
      "Content-Type must be application/gpx+xml, text/xml, or multipart/form-data",
    ),
  };
}

export async function POST(request: NextRequest) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader && Number(contentLengthHeader) > MAX_GPX_BYTES) {
    return jsonError(413, "GPX file exceeds the 5 MB limit");
  }

  const body = await readGpxFromRequest(request);
  if ("error" in body) {
    return body.error;
  }
  const { xml, filename } = body;

  let track: Track;
  try {
    track = parseGpx(xml);
  } catch (error) {
    if (error instanceof GpxParseError) {
      // GpxParseError's message already ends in "(line N)" (P-1's
      // requirement that a malformed file names where it broke), so it is
      // returned verbatim rather than reformatted.
      return jsonError(400, error.message);
    }
    throw error;
  }

  const name = deriveActivityName(xml, filename, track);

  const { activityId, distanceM } = await withUser(userId, async (client) => {
    const id = await insertActivity(client, userId, { name, source: "gpx", track });
    const { rows } = await client.query<{ distance_m: number }>(
      "select distance_m from activities where id = $1",
      [id],
    );
    return { activityId: id, distanceM: rows[0]?.distance_m ?? 0 };
  });

  // Sent after the transaction above has committed, following the same
  // best-effort pattern POST /api/entries uses for photo/uploaded: the
  // activity is already persisted by this point, so a failed enqueue must
  // not fail a request that otherwise fully succeeded. trail.match can
  // always be re-triggered later; there is nothing here for it to race.
  await inngest
    .send({ name: "activity/created", data: { activityId, userId } })
    .catch((error: unknown) => {
      console.error(`failed to enqueue activity/created for ${activityId}:`, error);
    });

  return jsonOk(
    {
      id: activityId,
      name,
      pointCount: track.points.length,
      distanceM,
      elapsedSeconds: track.endedAt - track.startedAt,
      warnings: track.warnings,
    },
    { status: 201 },
  );
}
