import type { PoolClient } from "pg";
import { correlate as runCorrelate } from "@waypoint/correlation";
import type { Photo as CorrelationPhoto, Track } from "@waypoint/correlation";
import { withUser } from "@/lib/db";
import { loadTrackPoints } from "@/lib/track";
import { inngest } from "./client";

interface PhotoEventData {
  photoId: string;
  userId: string;
}

interface PhotoRow {
  id: string;
  captured_naive: string | null;
  exif: PhotoExif | null;
  clock_offset_s: number | null;
}

interface PhotoExif {
  offsetTimeOriginal?: string | null;
  gps?: { latitude: number; longitude: number } | null;
}

// EXIF's OffsetTimeOriginal is always "+HH:MM" or "-HH:MM" (a fixed sign,
// unlike ISO 8601 which allows a bare "Z"). exifr's raw-string parse (see
// photo.ts) leaves it exactly in that shape, so a small fixed-format parser
// is all this needs -- no general offset-string library required.
function parseExifOffsetSeconds(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const [, sign, hours, minutes] = match;
  const magnitude = Number(hours) * 3600 + Number(minutes) * 60;
  return sign === "-" ? -magnitude : magnitude;
}

function toCorrelationPhoto(row: PhotoRow): CorrelationPhoto {
  const gps = row.exif?.gps ?? null;
  return {
    id: row.id,
    capturedNaive: row.captured_naive,
    exifOffsetSeconds: parseExifOffsetSeconds(row.exif?.offsetTimeOriginal),
    exifPosition: gps ? { lat: gps.latitude, lon: gps.longitude, ele: null } : null,
    cameraOffsetSeconds: row.clock_offset_s ?? 0,
  };
}

/**
 * Whether every photo attached to `entryId` has left `uploaded` -- the
 * fan-in gate. Deliberately a database predicate rather than an Inngest step
 * counter: a step counter needs every participant to run exactly once and to
 * agree on a shared total up front, which a retried step (Inngest retries
 * `exif.extract` up to 3 times per photo) can violate by running its
 * increment twice. Re-reading "how many photos are still `uploaded` right
 * now" from the table is naturally idempotent -- running it twice after the
 * same state change gives the same answer -- and it survives a job restart
 * for free, since the state it reads is the durable state, not counter memory
 * that a crash would lose.
 *
 * `activities.track` is `not null` in the schema, so an entry's activity
 * always has a track by the time this runs; no separate check is needed for
 * it.
 */
async function entryReadyForCorrelation(client: PoolClient, entryId: string): Promise<boolean> {
  const { rows } = await client.query<{ uploaded_count: string; total_count: string }>(
    `select
       count(*) filter (where status = 'uploaded') as uploaded_count,
       count(*) as total_count
     from photos
     where entry_id = $1`,
    [entryId],
  );
  const row = rows[0];
  if (!row) return false;
  return Number(row.total_count) > 0 && Number(row.uploaded_count) === 0;
}

export type CorrelateEntryOutcome = { placed: number; unplaced: number };

/**
 * Runs correlation for one entry and persists the result. Re-runnable: every
 * call deletes and re-inserts that entry's `photo_locations` rows rather than
 * patching them, which is what makes a retried or manually re-triggered
 * correlation safe (§6 -- `photo_locations` is a separate table from `photos`
 * for exactly this reason).
 *
 * Manual placements are the one exception to that delete-and-reinsert
 * strategy. Correlation is re-runnable by design, but an author who has
 * dragged a pin has given the system a more reliable answer than the
 * algorithm can produce, and a re-run must not silently discard it.
 */
export async function correlateEntry(entryId: string, userId: string): Promise<CorrelateEntryOutcome> {
  return withUser(userId, async (client) => {
    const { rows: entryRows } = await client.query<{ activity_id: string }>(
      "select activity_id from entries where id = $1",
      [entryId],
    );
    const activityId = entryRows[0]?.activity_id;
    if (!activityId) {
      throw new Error(`entry not found: ${entryId}`);
    }

    const points = await loadTrackPoints(client, activityId);
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    if (!firstPoint || !lastPoint) {
      throw new Error(`activity has no track points: ${activityId}`);
    }
    const track: Track = {
      points,
      startedAt: firstPoint.time,
      endedAt: lastPoint.time,
      warnings: [],
    };

    const { rows: photoRows } = await client.query<PhotoRow>(
      // to_char, not a plain ::text cast: the correlation engine's
      // capturedNaive parser (naiveToUtcSeconds) requires the ISO
      // "YYYY-MM-DDTHH:MM:SS" separator, and ::text on a `timestamp` renders
      // a space there instead.
      `select p.id, to_char(p.captured_naive, 'YYYY-MM-DD"T"HH24:MI:SS') as captured_naive,
              p.exif, cp.clock_offset_s
       from photos p
       left join camera_profiles cp on cp.id = p.camera_id
       where p.entry_id = $1`,
      [entryId],
    );
    const photos = photoRows.map(toCorrelationPhoto);

    const result = runCorrelate(track, photos);

    const { rows: manualRows } = await client.query<{ photo_id: string }>(
      `select pl.photo_id
       from photo_locations pl
       join photos p on p.id = pl.photo_id
       where p.entry_id = $1 and pl.method = 'manual'`,
      [entryId],
    );
    const manuallyPlacedPhotoIds = new Set(manualRows.map((row) => row.photo_id));

    await client.query(
      `delete from photo_locations
       where photo_id in (select id from photos where entry_id = $1) and method <> 'manual'`,
      [entryId],
    );

    for (const placement of result.placed) {
      if (manuallyPlacedPhotoIds.has(placement.photoId)) continue;
      await client.query(
        `insert into photo_locations
           (photo_id, geom, elevation_m, method, confidence, gap_seconds, applied_offset_s, distance_along_m)
         values
           ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4, $5, $6, $7, $8, $9)`,
        [
          placement.photoId,
          placement.lon,
          placement.lat,
          placement.elevationM,
          placement.method,
          placement.confidence,
          placement.gapSeconds,
          placement.appliedOffsetSeconds,
          placement.distanceAlongM,
        ],
      );
      await client.query(`update photos set captured_at = to_timestamp($2) where id = $1`, [
        placement.photoId,
        placement.capturedAt,
      ]);
    }

    // Unplaced photos get no photo_locations row and stay attached to the
    // entry exactly as they were -- inventing a location for them would be
    // worse than showing none. A manually placed photo counts as placed
    // regardless of whether the algorithm's own run also placed it: it has a
    // location either way, and the algorithm's placement was skipped in favor
    // of the author's.
    const placedPhotoIds = new Set(result.placed.map((placement) => placement.photoId));
    for (const photoId of manuallyPlacedPhotoIds) {
      placedPhotoIds.add(photoId);
    }
    const unplacedPhotoIds = new Set(result.unplaced.map((photo) => photo.photoId));
    for (const photoId of manuallyPlacedPhotoIds) {
      unplacedPhotoIds.delete(photoId);
    }
    return { placed: placedPhotoIds.size, unplaced: unplacedPhotoIds.size };
  });
}

async function entryIdForPhoto(client: PoolClient, photoId: string): Promise<string | null> {
  const { rows } = await client.query<{ entry_id: string }>(
    "select entry_id from photos where id = $1",
    [photoId],
  );
  return rows[0]?.entry_id ?? null;
}

export type CorrelationCheckOutcome =
  | { status: "correlated"; placed: number; unplaced: number }
  | { status: "not-ready" };

export async function checkAndCorrelate(photoId: string, userId: string): Promise<CorrelationCheckOutcome> {
  const entryId = await withUser(userId, (client) => entryIdForPhoto(client, photoId));
  if (!entryId) {
    throw new Error(`photo not found: ${photoId}`);
  }

  const ready = await withUser(userId, (client) => entryReadyForCorrelation(client, entryId));
  if (!ready) {
    return { status: "not-ready" };
  }

  const outcome = await correlateEntry(entryId, userId);
  return { status: "correlated", ...outcome };
}

// Triggered by `photo/exif.settled`, which fires whether EXIF extraction
// succeeded or failed. That distinction is the whole point: the barrier waits
// for every photo in the entry to leave `uploaded`, and failing is one of the
// ways a photo does that. Listening to the success-only event instead -- which
// is what `photo-derive` correctly does -- means an entry whose last photo
// fails never reaches the barrier and silently never correlates.
//
// The gate re-reads the entry's whole state rather than counting events, so a
// redelivered event is harmless and the check is order-independent.
export const photoCorrelateCheck = inngest.createFunction(
  { id: "photo-correlate-check", retries: 3, triggers: [{ event: "photo/exif.settled" }] },
  async ({ event, step }) => {
    const { photoId, userId } = event.data as PhotoEventData;
    return step.run("check-and-correlate", () => checkAndCorrelate(photoId, userId));
  },
);
