import { z } from "zod";
import type { NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { correlateEntry } from "@/lib/jobs/correlate";
import { jsonError, jsonOk, parseBody } from "@/lib/http";
import { entryPaths, purge } from "@/lib/revalidate";

// 'assumed' is deliberately not accepted here: it is the state a fresh
// profile starts in (see the upsert in lib/jobs/photo.ts), not a value an
// author chooses -- the only two ways a human sets this offset are reading
// it off a photographed watch face or typing in a known correction.
const bodySchema = z.object({
  clockOffsetSeconds: z.number().int().min(-86400).max(86400),
  offsetSource: z.enum(["watch_face", "manual"]),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }
  const { id: cameraId } = await context.params;

  const parsed = await parseBody(request, bodySchema);
  if (!parsed.ok) return parsed.response;
  const { clockOffsetSeconds, offsetSource } = parsed.data;

  const rowCount = await withUser(userId, async (client) => {
    // RLS (camera_profiles_own) scopes this to the caller's own profiles, so
    // zero rows updated means "not yours" and "doesn't exist" alike, exactly
    // as elsewhere in this API.
    const result = await client.query(
      `update camera_profiles
         set clock_offset_s = $2, offset_source = $3, calibrated_at = now()
       where id = $1`,
      [cameraId, clockOffsetSeconds, offsetSource],
    );
    return result.rowCount ?? 0;
  });

  if (!rowCount) {
    return jsonError(404, "Camera not found");
  }

  // The stored offset is an input to correlation (see correlate.ts), so a
  // changed offset that does not move any pins is a setting that appears not
  // to work. Every entry with a photograph from this camera is re-run after
  // the update commits, not inside the same transaction, so re-correlation
  // sees the offset that was just saved rather than racing it.
  //
  // correlateEntry preserves manually-placed pins (method = 'manual'), so an
  // author's own drag-to-correct survives this re-run -- that guarantee was
  // added alongside P-6 for exactly this kind of automated re-placement.
  const entryIds = await withUser(userId, async (client) => {
    const { rows } = await client.query<{ entry_id: string }>(
      "select distinct p.entry_id from photos p where p.camera_id = $1",
      [cameraId],
    );
    return rows.map((row) => row.entry_id);
  });

  const affectedPaths: string[] = [];
  for (const entryId of entryIds) {
    await correlateEntry(entryId, userId);
    // The pins on this entry's published page just moved, so its cached
    // paths need the same purge a manual re-correlation would trigger.
    const paths = await withUser(userId, (client) => entryPaths(client, entryId));
    affectedPaths.push(...paths);
  }
  purge(affectedPaths);

  return jsonOk({ ok: true, recorrelated: entryIds.length });
}
