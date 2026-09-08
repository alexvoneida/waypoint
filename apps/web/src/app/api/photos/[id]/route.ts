import { z } from "zod";
import type { NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError, jsonOk, parseBody } from "@/lib/http";
import { entryPaths, purge } from "@/lib/revalidate";

const bodySchema = z
  .object({
    hidden: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    position: z
      .object({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
      })
      .optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Nothing to update",
  });

const COLUMNS = {
  hidden: "hidden",
  sortOrder: "sort_order",
} as const;

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }
  const { id: photoId } = await context.params;

  const parsed = await parseBody(request, bodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const assignments: string[] = [];
  const values: unknown[] = [photoId];
  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = body[field as keyof typeof COLUMNS];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  const result = await withUser(userId, async (client) => {
    // RLS (photos_own) scopes this select to the caller's own photos, so a
    // missing row is both "not yours" and "doesn't exist" -- the same
    // conflation the entries route relies on for its 404.
    const { rows } = await client.query<{ id: string; entry_id: string; activity_id: string }>(
      `select p.id, p.entry_id, e.activity_id
       from photos p join entries e on e.id = p.entry_id
       where p.id = $1`,
      [photoId],
    );
    const photo = rows[0];
    if (!photo) return { error: "not-found" as const };

    if (assignments.length > 0) {
      const { rowCount } = await client.query(
        `update photos set ${assignments.join(", ")} where id = $1`,
        values,
      );
      if (!rowCount) return { error: "not-found" as const };
    }

    if (body.position) {
      await client.query(
        `with activity as (
           select track, distance_m from activities where id = $2
         ),
         snapped as (
           select
             ST_ClosestPoint(ST_Force2D(a.track), ST_SetSRID(ST_MakePoint($3, $4), 4326)) as geom_2d,
             ST_LineLocatePoint(ST_Force2D(a.track), ST_SetSRID(ST_MakePoint($3, $4), 4326)) as fraction,
             a.track as track,
             a.distance_m as distance_m
           from activity a
         ),
         interpolated as (
           select
             s.geom_2d,
             s.fraction * s.distance_m as distance_along_m,
             ST_Z(ST_LineInterpolatePoint(ST_Force3D(s.track), s.fraction)) as elevation_m
           from snapped s
         )
         insert into photo_locations
           (photo_id, geom, elevation_m, method, confidence, gap_seconds, applied_offset_s, distance_along_m)
         -- applied_offset_s is 0 and confidence is 'high' because a manual
         -- placement has no timing offset to apply and no ambiguity about
         -- where the photo belongs -- the author put the pin there directly.
         select $1, i.geom_2d::geography, i.elevation_m, 'manual', 'high', null, 0, i.distance_along_m
         from interpolated i
         on conflict (photo_id) do update set
           geom = excluded.geom,
           elevation_m = excluded.elevation_m,
           method = 'manual',
           confidence = 'high',
           gap_seconds = null,
           distance_along_m = excluded.distance_along_m`,
        [photoId, photo.activity_id, body.position.lon, body.position.lat],
      );
    }

    const paths = await entryPaths(client, photo.entry_id);
    return { error: null, paths };
  });

  if (result.error === "not-found") {
    return jsonError(404, "Photograph not found");
  }

  purge(result.paths);
  return jsonOk({ ok: true });
}
