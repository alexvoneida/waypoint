import exifr from "exifr";
import type { PoolClient } from "pg";
import { withUser } from "@/lib/db";
import { getObjectBytes, objectKey, putObjectBytes } from "@/lib/storage";
import { inngest } from "./client";
import { deriveVariants } from "./derive-image";

// Both functions take { photoId, userId } rather than just { photoId }: every
// query below runs through withUser for row-level security (photos_own
// resolves through entries.user_id), and a background job has no session to
// read that id from. The event producer -- the future POST /api/entries,
// which is what actually knows who owns the batch -- always has it on hand.
interface PhotoEventData {
  photoId: string;
  userId: string;
}

const EXIF_MISSING_MESSAGE =
  "DateTimeOriginal is missing from this photo's EXIF. The most likely cause " +
  "is a Lightroom export preset with metadata minimized or stripped -- check " +
  "the export dialog's Metadata section is set to include camera data, and " +
  "re-export.";

interface PhotoRow {
  entry_id: string;
  key_original: string;
  status: string;
}

async function loadPhoto(client: PoolClient, photoId: string): Promise<PhotoRow> {
  const { rows } = await client.query<PhotoRow>(
    "select entry_id, key_original, status from photos where id = $1",
    [photoId],
  );
  const photo = rows[0];
  if (!photo) {
    throw new Error(`photo not found: ${photoId}`);
  }
  return photo;
}

async function markFailed(client: PoolClient, photoId: string, message: string): Promise<void> {
  await client.query(
    `update photos
       set status = 'failed', exif = coalesce(exif, '{}'::jsonb) || $2::jsonb
     where id = $1`,
    [photoId, JSON.stringify({ error: message })],
  );
}

// EXIF's DateTimeOriginal is "YYYY:MM:DD HH:MM:SS": colon-separated date,
// space, colon-separated time. Postgres's `timestamp` (no time zone) column
// wants "YYYY-MM-DD HH:MM:SS" and applies no zone conversion of its own, so
// this is a pure string reformat, never a Date round trip -- going through a
// JS Date here (as exifr's default parsing does) would silently reinterpret
// the naive local time as the *server's* local time.
function toNaiveTimestampLiteral(exifDateTime: string): string {
  const [datePart, timePart] = exifDateTime.split(" ");
  if (!datePart || !timePart) {
    throw new Error(`unrecognized EXIF DateTimeOriginal format: ${exifDateTime}`);
  }
  return `${datePart.replaceAll(":", "-")} ${timePart}`;
}

export type ExifExtractOutcome = { status: "processing" } | { status: "failed" };

export async function extractExifForPhoto(photoId: string, userId: string): Promise<ExifExtractOutcome> {
  return withUser(userId, async (client) => {
    const photo = await loadPhoto(client, photoId);
    await client.query(`update photos set status = 'processing' where id = $1`, [photoId]);

    const bytes = await getObjectBytes(photo.key_original);

    // reviveValues:false keeps DateTimeOriginal as this raw string instead of
    // exifr's default Date object, which is built by interpreting the naive
    // local string as the *runtime's* local time zone -- exactly the
    // corruption captured_naive exists to avoid.
    let tags: Record<string, unknown>;
    try {
      tags = await exifr.parse(bytes, { reviveValues: false, tiff: true, exif: true });
    } catch (error) {
      await markFailed(client, photoId, `Could not read EXIF data: ${(error as Error).message}`);
      return { status: "failed" };
    }

    const rawTimestamp = tags.DateTimeOriginal as string | undefined;
    if (!rawTimestamp) {
      await markFailed(client, photoId, EXIF_MISSING_MESSAGE);
      return { status: "failed" };
    }

    // A second, ordinary parse for GPS: exifr's `gps` option computes decimal
    // latitude/longitude regardless of reviveValues, so this stays a separate
    // call rather than complicating the raw-string parse above.
    const gpsTags = await exifr.parse(bytes, { gps: true }).catch(() => null);
    const gps =
      gpsTags?.latitude != null && gpsTags?.longitude != null
        ? { latitude: gpsTags.latitude as number, longitude: gpsTags.longitude as number }
        : null;

    const exifSummary = {
      lens: (tags.LensModel as string) ?? null,
      focalLength: (tags.FocalLength as number) ?? null,
      aperture: (tags.FNumber as number) ?? null,
      shutterSpeed: (tags.ExposureTime as number) ?? null,
      iso: (tags.ISO as number) ?? null,
      offsetTimeOriginal: (tags.OffsetTimeOriginal as string) ?? null,
      gps,
    };

    await client.query(
      `update photos
         set captured_naive = $2, exif = $3::jsonb, status = 'processing'
       where id = $1`,
      [photoId, toNaiveTimestampLiteral(rawTimestamp), JSON.stringify(exifSummary)],
    );

    return { status: "processing" };
  });
}

export type DeriveOutcome = { status: "ready" } | { status: "skipped" };

export async function deriveForPhoto(photoId: string, userId: string): Promise<DeriveOutcome> {
  return withUser(userId, async (client) => {
    const photo = await loadPhoto(client, photoId);

    // Only reachable directly (a retry, or test-pipeline.mjs calling this
    // function on its own) since the Inngest chain only fires this function
    // from the event exif.extract sends on success. A failed photo has
    // nothing to derive from, and re-running must be a no-op, not an error.
    if (photo.status === "failed") {
      return { status: "skipped" };
    }

    const original = await getObjectBytes(photo.key_original);
    const derived = await deriveVariants(original);

    const keys: Record<"full" | "web" | "thumb", string> = {
      full: objectKey(userId, photo.entry_id, photoId, "full"),
      web: objectKey(userId, photo.entry_id, photoId, "web"),
      thumb: objectKey(userId, photo.entry_id, photoId, "thumb"),
    };

    for (const variant of derived.variants) {
      await putObjectBytes(keys[variant.variant], variant.bytes, "image/webp");
    }

    await client.query(
      `update photos
         set key_full = $2, key_web = $3, key_thumb = $4,
             width = $5, height = $6, blur_hash = $7, status = 'ready'
       where id = $1`,
      [photoId, keys.full, keys.web, keys.thumb, derived.width, derived.height, derived.blurHash],
    );

    return { status: "ready" };
  });
}

export const exifExtract = inngest.createFunction(
  { id: "photo-exif-extract", retries: 3, triggers: [{ event: "photo/uploaded" }] },
  async ({ event, step }) => {
    const { photoId, userId } = event.data as PhotoEventData;
    const outcome = await step.run("extract-exif", () => extractExifForPhoto(photoId, userId));

    // Sent whether the photo succeeded or failed. The correlation fan-in waits
    // for every photo in the batch to leave 'uploaded', and a failure is one of
    // the ways that happens - firing only on success means a batch whose last
    // photo fails never reaches the barrier and silently never correlates.
    await step.sendEvent("photo-settled", {
      name: "photo/exif.settled",
      data: { photoId, userId },
    });

    if (outcome.status === "failed") {
      return outcome;
    }

    // Derive is chained by event rather than by a direct call so that a
    // re-delivered exif.extract and a re-delivered derive stay independently
    // retryable instead of being coupled into one longer step.
    await step.sendEvent("queue-derive", {
      name: "photo/exif.extracted",
      data: { photoId, userId },
    });
    return outcome;
  },
);

export const derive = inngest.createFunction(
  { id: "photo-derive", retries: 3, triggers: [{ event: "photo/exif.extracted" }] },
  async ({ event, step }) => {
    const { photoId, userId } = event.data as PhotoEventData;
    return step.run("derive-images", () => deriveForPhoto(photoId, userId));
  },
);
