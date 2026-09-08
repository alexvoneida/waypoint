import type { Track, TrackPoint } from "@waypoint/correlation";
import type { StravaStreams, StravaSummaryActivity } from "./api";

export class StravaImportError extends Error {}

/**
 * Turns Strava's streams into the same `Track` the GPX parser produces, so
 * everything downstream -- correlation, trail matching, the entry page --
 * cannot tell an imported activity from an uploaded one. That is N-3's
 * "the same internal representation" requirement, and it is what keeps
 * Strava additive rather than a second pipeline (§12).
 *
 * The `time` stream is seconds elapsed from `start_date`, verified in Phase 0
 * to end exactly at `elapsed_time` (§14). Streams come back index-aligned and
 * at full resolution, so `latlng[i]` and `time[i]` describe one point.
 */
export function streamsToTrack(activity: StravaSummaryActivity, streams: StravaStreams): Track {
  const startSeconds = Math.floor(activity.startDate.getTime() / 1000);
  const warnings: string[] = [];

  // Index-alignment is the whole basis for reading these arrays together.
  // Phase 0 measured them equal in length; a future response where they are
  // not must truncate rather than pair a position with another point's
  // timestamp.
  const length = Math.min(streams.latlng.length, streams.time.length);
  if (streams.latlng.length !== streams.time.length) {
    warnings.push(
      `latlng and time streams differed in length (${streams.latlng.length} vs ${streams.time.length}); ` +
        `used the first ${length} points of each`,
    );
  }
  const altitude = streams.altitude && streams.altitude.length >= length ? streams.altitude : null;
  if (streams.altitude && !altitude) {
    warnings.push("altitude stream was shorter than the position stream and was ignored");
  }

  const points: TrackPoint[] = [];
  let lastTime = -Infinity;
  let outOfOrder = 0;

  for (let index = 0; index < length; index += 1) {
    const position = streams.latlng[index];
    const elapsed = streams.time[index];
    if (!position || !Number.isFinite(elapsed)) continue;

    const [lat, lon] = position;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const time = startSeconds + (elapsed as number);
    // The parser guarantees ascending time and the engine relies on it. A
    // stream that repeats or goes backwards is dropped here rather than
    // sorted: a Strava time stream is monotonic by construction, so a
    // violation means the data is wrong, not merely out of order.
    if (time <= lastTime) {
      outOfOrder += 1;
      continue;
    }
    lastTime = time;

    points.push({ lat, lon, ele: altitude?.[index] ?? null, time });
  }

  if (outOfOrder > 0) {
    warnings.push(`dropped ${outOfOrder} point(s) whose elapsed time did not advance`);
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2) {
    throw new StravaImportError("the activity's position stream has fewer than two usable points");
  }

  return { points, startedAt: first.time, endedAt: last.time, warnings };
}

/**
 * Maps Strava's `sport_type` onto `sport_t`. The product is hiking only (§1),
 * and every tuned constant in correlation assumes walking pace -- so anything
 * that is not travel on foot is imported as 'other' rather than being
 * pretended into a hike.
 */
const HIKE_SPORT_TYPES = new Set(["Hike", "Walk", "Snowshoe", "TrailRun"]);

export function toSport(sportType: string): "hike" | "other" {
  return HIKE_SPORT_TYPES.has(sportType) ? "hike" : "other";
}
