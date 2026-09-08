import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError, jsonOk, parseBody } from "@/lib/http";
import { inngest } from "@/lib/jobs/client";
import { getObjectBytes } from "@/lib/storage";

const bodySchema = z.object({
  activityId: z.string().uuid(),
  title: z.string().min(1).max(200),
  notes: z.string().max(5000).optional(),
  photoKeys: z.array(z.string().min(1)).min(1).max(100),
});

interface ActivityRow {
  started_at: string;
}

async function sha256OfObject(key: string): Promise<Buffer> {
  // getObjectBytes already buffers the whole object in memory (it drives the
  // same S3 GetObject the EXIF job uses), so hashing is done over that buffer
  // rather than re-reading the stream a second time. What matters for §6's
  // requirement is that the checksum comes from the object actually sitting
  // in the bucket, never from a value the client hands us -- a client can lie
  // about a checksum, it cannot lie about what bytes we fetch.
  const bytes = await getObjectBytes(key);
  return createHash("sha256").update(bytes).digest();
}

export async function POST(request: NextRequest) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }

  const parsed = await parseBody(request, bodySchema);
  if (!parsed.ok) return parsed.response;
  const { activityId, title, notes, photoKeys } = parsed.data;

  // A presigned upload key is scoped to this user's namespace
  // (originals/<userId>/...) at signing time. Rejecting anything outside it
  // here is defense in depth against a client passing back someone else's
  // key -- RLS never gets a chance to weigh in on this check because it isn't
  // a query, it's a string the request handed us.
  const foreignKey = photoKeys.find((key) => !key.startsWith(`originals/${userId}/`));
  if (foreignKey) {
    return jsonError(400, "photoKeys must belong to the signed-in user's own uploads");
  }

  const created = await withUser(userId, async (client) => {
    // RLS scopes this select to the caller's own activities already
    // (activities_own), so a row simply not coming back -- rather than a
    // foreign-key violation on the insert below -- is how "this activity
    // isn't yours" and "this activity doesn't exist" both surface. Either
    // way the caller gets a 404, never a 500.
    const { rows: activityRows } = await client.query<ActivityRow>(
      "select started_at from activities where id = $1",
      [activityId],
    );
    const activity = activityRows[0];
    if (!activity) {
      return { notFound: true as const };
    }

    // The track carries no time zone (P-1's local_zone lookup is a later
    // phase), so the occurred-on date is provisionally read off started_at in
    // UTC. This can land on the wrong calendar day for a hike near midnight
    // in its actual zone; it is corrected once local_zone is populated.
    const { rows: entryRows } = await client.query<{ id: string }>(
      `insert into entries (user_id, activity_id, title, notes, occurred_on, status, slug)
       values ($1, $2, $3, $4, ($5::timestamptz at time zone 'UTC')::date, 'draft', null)
       returning id`,
      [userId, activityId, title, notes ?? null, activity.started_at],
    );
    const entryId = entryRows[0]?.id;
    if (!entryId) {
      throw new Error("entry insert returned no id");
    }

    const photos: { photoId: string; key: string }[] = [];
    for (const key of photoKeys) {
      const checksum = await sha256OfObject(key);
      const { rows: photoRows } = await client.query<{ id: string }>(
        `insert into photos (entry_id, checksum, key_original, status)
         values ($1, $2, $3, 'uploaded')
         returning id`,
        [entryId, checksum, key],
      );
      const photoId = photoRows[0]?.id;
      if (!photoId) {
        throw new Error("photo insert returned no id");
      }
      photos.push({ photoId, key });
    }

    return { notFound: false as const, entryId, photos };
  });

  if (created.notFound) {
    return jsonError(404, "Activity not found");
  }

  // Sent after the transaction above has committed: a job that ran before
  // the photo row was visible to other connections would just fail to find
  // it, for no benefit.
  //
  // Failure to enqueue is logged, not thrown: the entry and its photos are
  // already committed by this point, and photos.status stays 'uploaded'
  // rather than silently advancing, so a missed event is visible (the photo
  // never leaves 'uploaded') and retriable, instead of unwinding a request
  // that otherwise fully succeeded because the queue was unreachable.
  await Promise.all(
    created.photos.map((photo) =>
      inngest
        .send({ name: "photo/uploaded", data: { photoId: photo.photoId, userId } })
        .catch((error: unknown) => {
          console.error(`failed to enqueue photo/uploaded for ${photo.photoId}:`, error);
        }),
    ),
  );

  return jsonOk(
    {
      id: created.entryId,
      photoIds: created.photos.map((photo) => photo.photoId),
    },
    { status: 201 },
  );
}
