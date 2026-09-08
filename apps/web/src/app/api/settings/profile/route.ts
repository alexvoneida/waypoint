import { z } from "zod";
import type { NextRequest } from "next/server";
import { handleSchema, visibilitySchema } from "@/lib/account";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError, jsonOk, parseBody } from "@/lib/http";
import { accountPaths, purge } from "@/lib/revalidate";

// A radius of 0 is how the feature is switched off (§6), so it is a valid
// value rather than a missing one. The centre is nullable for the same
// reason: clearing it is a thing the settings screen must be able to say.
const bodySchema = z
  .object({
    handle: handleSchema.optional(),
    displayName: z.string().min(1).max(100).optional(),
    profileVisibility: visibilitySchema.optional(),
    privacyRadiusM: z.number().int().min(0).max(20_000).optional(),
    privacyCenter: z
      .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
      .nullable()
      .optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Nothing to update",
  });

// Column per accepted field, so the SET clause is assembled from this table
// and never from a request key.
const COLUMNS = {
  handle: "handle",
  displayName: "display_name",
  profileVisibility: "profile_visibility",
  privacyRadiusM: "privacy_radius_m",
} as const;

export async function PATCH(request: NextRequest) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }

  const parsed = await parseBody(request, bodySchema);
  if (!parsed.ok) return parsed.response;

  const assignments: string[] = [];
  const values: unknown[] = [userId];
  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = parsed.data[field as keyof typeof COLUMNS];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  // privacy_center is a geography column, so it is built rather than bound:
  // the point is assembled from two bound numbers, never from interpolated
  // text.
  const { privacyCenter } = parsed.data;
  if (privacyCenter === null) {
    assignments.push("privacy_center = null");
  } else if (privacyCenter) {
    values.push(privacyCenter.lon, privacyCenter.lat);
    assignments.push(
      `privacy_center = ST_SetSRID(ST_MakePoint($${values.length - 1}, $${values.length}), 4326)::geography`,
    );
  }

  try {
    const paths = await withUser(userId, async (client) => {
      // Collected on both sides of the update. A handle change moves every
      // one of this account's public URLs, so the pages cached under the old
      // handle are exactly the ones nothing else will ever purge.
      const before = await accountPaths(client, userId);
      await client.query(`update users set ${assignments.join(", ")} where id = $1`, values);
      const after = await accountPaths(client, userId);
      return [...before, ...after];
    });

    // §7: a visibility change that stops *generating* public pages but leaves
    // the cached ones being served is the privacy bug this phase exists to
    // avoid. Purging unconditionally -- rather than only when
    // profileVisibility was in the body -- costs a regeneration on a display
    // name edit and removes the chance of getting the condition wrong.
    purge(paths);
  } catch (error) {
    const pgError = error as { code?: string; constraint?: string };
    if (pgError.code === "23505" && pgError.constraint === "users_handle_key") {
      return jsonError(409, "That handle is already taken");
    }
    throw error;
  }

  return jsonOk({ ok: true });
}
