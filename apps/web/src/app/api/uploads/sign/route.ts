import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { jsonError, jsonOk, parseBody } from "@/lib/http";
import { objectKey, presignUpload } from "@/lib/storage";

// This product takes Lightroom JPG exports and nothing else (§8) -- no RAF,
// no HEIC, no PNG.
const ALLOWED_CONTENT_TYPE = "image/jpeg";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_BATCH_SIZE = 100;

const fileSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string(),
  contentLength: z.number().int().positive(),
});

const bodySchema = z.array(fileSchema).min(1).max(MAX_BATCH_SIZE);

export async function POST(request: NextRequest) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }

  const parsed = await parseBody(request, bodySchema);
  if (!parsed.ok) {
    return parsed.response;
  }
  const files = parsed.data;

  const wrongType = files.filter((file) => file.contentType !== ALLOWED_CONTENT_TYPE);
  if (wrongType.length > 0) {
    return jsonError(415, "Only image/jpeg uploads are accepted", {
      files: wrongType.map((file) => file.filename),
    });
  }

  const tooLarge = files.filter((file) => file.contentLength > MAX_FILE_BYTES);
  if (tooLarge.length > 0) {
    return jsonError(413, "File exceeds the 50 MB per-photo limit", {
      files: tooLarge.map((file) => file.filename),
    });
  }

  // A presigned URL is a capability: whoever holds it can write to that exact
  // key, no further auth check applied. So the key is built here from the
  // session's user id and freshly generated server-side ids, never from
  // anything in the request body -- a client-supplied key would let a signed-in
  // user obtain a writable URL into another account's namespace just by asking
  // for it by name.
  //
  // The entries row these photos will belong to does not exist yet (it is
  // created afterwards by POST /api/entries from the uploaded keys), so a
  // fresh id stands in for it here purely to namespace this batch's objects.
  // The eventual entries.id can differ from it; nothing depends on the two
  // matching, because photos.key_original stores the exact string used here.
  const batchId = randomUUID();

  const signed = await Promise.all(
    files.map(async (file) => {
      const photoId = randomUUID();
      const key = objectKey(userId, batchId, photoId, "original");
      const uploadUrl = await presignUpload(key, file.contentType, file.contentLength);
      return { filename: file.filename, photoId, key, uploadUrl };
    }),
  );

  return jsonOk({ files: signed });
}
