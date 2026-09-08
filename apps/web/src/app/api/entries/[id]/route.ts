import { z } from "zod";
import type { NextRequest } from "next/server";
import { visibilitySchema } from "@/lib/account";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError, jsonOk, parseBody } from "@/lib/http";
import { entryPaths, purge } from "@/lib/revalidate";

const bodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    notes: z.string().max(10_000).nullable().optional(),
    visibility: visibilitySchema.optional(),
    leadPhotoId: z.uuid().nullable().optional(),
    commentsOpen: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Nothing to update",
  });

const COLUMNS = {
  title: "title",
  notes: "notes",
  visibility: "visibility",
  leadPhotoId: "lead_photo_id",
  commentsOpen: "comments_open",
} as const;

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }
  const { id: entryId } = await context.params;

  const parsed = await parseBody(request, bodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const assignments: string[] = [];
  const values: unknown[] = [entryId];
  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = body[field as keyof typeof COLUMNS];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  const result = await withUser(userId, async (client) => {
    // lead_photo_id has a foreign key to photos but no constraint tying it to
    // *this* entry, so a photo id from another of the caller's entries would
    // otherwise be accepted and render an unrelated frame as the card image.
    if (body.leadPhotoId) {
      const { rowCount } = await client.query(
        "select 1 from photos where id = $1 and entry_id = $2",
        [body.leadPhotoId, entryId],
      );
      if (!rowCount) return { error: "lead-photo" as const };
    }

    // Paths are collected on both sides of the update: entryPaths reads the
    // base tables, so the "before" read is what still knows the entry was
    // public and on a trail, and the "after" read picks up anything the
    // update moved it to.
    const before = await entryPaths(client, entryId);

    // RLS (entries_own) scopes this to the caller's own entries, so zero rows
    // updated means "not yours" and "doesn't exist" alike -- the same
    // conflation the publish route relies on, and the 404 §9 asks for.
    const { rowCount } = await client.query(
      `update entries set ${assignments.join(", ")} where id = $1`,
      values,
    );
    if (!rowCount) return { error: "not-found" as const };

    const after = await entryPaths(client, entryId);
    return { error: null, paths: [...before, ...after] };
  });

  if (result.error === "lead-photo") {
    return jsonError(400, "That photograph is not attached to this entry");
  }
  if (result.error === "not-found") {
    return jsonError(404, "Entry not found");
  }

  purge(result.paths);
  return jsonOk({ ok: true });
}
