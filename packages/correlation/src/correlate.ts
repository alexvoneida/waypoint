/**
 * Placing photographs on a GPS track.
 */

import { cumulativeDistances } from './geo.ts';
import { evaluateOffset, inferOffset, resolvePhotoInstant } from './offset.ts';
import { locate } from './interpolate.ts';
import { metresPerSecond, scoreConfidence } from './confidence.ts';
import type {
  Confidence,
  CorrelateOptions,
  CorrelationResult,
  OffsetInference,
  OffsetSeconds,
  Photo,
  PlacedPhoto,
  Track,
  UnplacedPhoto,
} from './types.ts';

const DEFAULT_GRACE_SECONDS = 900;

function nearestPointIndex(track: Track, instant: number): number {
  let bestIndex = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < track.points.length; i++) {
    const point = track.points[i];
    if (point === undefined) continue;
    const delta = Math.abs(point.time - instant);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function placeExifPhoto(photo: Photo, track: Track, cumulative: number[], offsetSeconds: OffsetSeconds | null): PlacedPhoto {
  const position = photo.exifPosition;
  if (!position) {
    throw new Error('placeExifPhoto called without exifPosition');
  }

  // A phone photo carries its own coordinates and always gets placed, so
  // capturedAt (non-nullable in PlacedPhoto) needs a best-effort value even
  // when the camera-photo offset search found nothing to resolve against, or
  // this particular photo wrote no EXIF timestamp at all. Falling back to
  // reading the naive timestamp as UTC, and failing that to the track start,
  // keeps photos orderable without pretending either value is authoritative.
  const resolvedOffset = offsetSeconds ?? 0;
  const capturedAt = resolvePhotoInstant(photo, resolvedOffset) ?? track.startedAt;
  const nearestIndex = track.points.length > 0 ? nearestPointIndex(track, capturedAt) : 0;
  const distanceAlongM = cumulative[nearestIndex] ?? 0;
  const appliedOffsetSeconds = resolvedOffset + (photo.cameraOffsetSeconds ?? 0);

  return {
    photoId: photo.id,
    lat: position.lat,
    lon: position.lon,
    elevationM: position.ele ?? null,
    method: 'exif',
    confidence: 'high',
    gapSeconds: null,
    appliedOffsetSeconds,
    distanceAlongM,
    capturedAt,
  };
}

/**
 * A position is only as trustworthy as the offset it was derived from. When the
 * search admits several offsets, `high` would be describing the interpolation
 * while saying nothing about the hours of slack behind it, and a viewer reads
 * one word for both. Capping at `medium` keeps the two uncertainties from being
 * confused on a public page.
 *
 * Photographs carrying their own EXIF coordinates are deliberately not capped:
 * their position never depended on the offset.
 */
function capForAmbiguousOffset(confidence: Confidence, ambiguous: boolean): Confidence {
  if (!ambiguous) return confidence;
  return confidence === 'high' ? 'medium' : confidence;
}

export function correlate(track: Track, photos: Photo[], options: CorrelateOptions = {}): CorrelationResult {
  const grace = options.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  const cumulative = cumulativeDistances(track.points);

  const exifPhotos = photos.filter((photo) => photo.exifPosition != null);
  const cameraPhotos = photos.filter((photo) => photo.exifPosition == null);

  const offset: OffsetInference =
    options.forceOffsetSeconds !== undefined
      ? evaluateOffset(options.forceOffsetSeconds, cameraPhotos, track, grace)
      : inferOffset(cameraPhotos, track, { graceSeconds: grace });

  const offsetSeconds = options.forceOffsetSeconds ?? offset.offsetSeconds;

  const placed: PlacedPhoto[] = [];
  const unplaced: UnplacedPhoto[] = [];

  for (const photo of exifPhotos) {
    placed.push(placeExifPhoto(photo, track, cumulative, offsetSeconds));
  }

  for (const photo of cameraPhotos) {
    if (photo.capturedNaive === null) {
      unplaced.push({ photoId: photo.id, reason: 'no-timestamp', capturedAt: null, outsideBySeconds: null });
      continue;
    }

    if (offsetSeconds === null) {
      unplaced.push({ photoId: photo.id, reason: 'no-offset-resolved', capturedAt: null, outsideBySeconds: null });
      continue;
    }

    const capturedAt = resolvePhotoInstant(photo, offsetSeconds);
    if (capturedAt === null) {
      unplaced.push({ photoId: photo.id, reason: 'no-timestamp', capturedAt: null, outsideBySeconds: null });
      continue;
    }

    const appliedOffsetSeconds = offsetSeconds + (photo.cameraOffsetSeconds ?? 0);

    const inTrack = locate(track, capturedAt, cumulative);
    if (inTrack !== null) {
      const speed = metresPerSecond(
        estimateSegmentDistance(track, cumulative, capturedAt),
        inTrack.gapSeconds,
      );
      const confidence = capForAmbiguousOffset(
        scoreConfidence({ gapSeconds: inTrack.gapSeconds, speedMetresPerSecond: speed }),
        offset.ambiguous,
      );
      placed.push({
        photoId: photo.id,
        lat: inTrack.lat,
        lon: inTrack.lon,
        elevationM: inTrack.elevationM,
        method: 'interpolated',
        confidence,
        gapSeconds: inTrack.gapSeconds,
        appliedOffsetSeconds,
        distanceAlongM: inTrack.distanceAlongM,
        capturedAt,
      });
      continue;
    }

    if (capturedAt < track.startedAt) {
      const outsideBySeconds = track.startedAt - capturedAt;
      if (outsideBySeconds <= grace) {
        placed.push(clampToEndpoint(photo, track, cumulative, capturedAt, appliedOffsetSeconds, 'start'));
        continue;
      }
      unplaced.push({ photoId: photo.id, reason: 'before-track', capturedAt, outsideBySeconds });
      continue;
    }

    const outsideBySeconds = capturedAt - track.endedAt;
    if (outsideBySeconds <= grace) {
      placed.push(clampToEndpoint(photo, track, cumulative, capturedAt, appliedOffsetSeconds, 'end'));
      continue;
    }
    unplaced.push({ photoId: photo.id, reason: 'after-track', capturedAt, outsideBySeconds });
  }

  placed.sort((a, b) => a.capturedAt - b.capturedAt);

  return { offset, placed, unplaced };
}

function clampToEndpoint(
  photo: Photo,
  track: Track,
  cumulative: number[],
  capturedAt: number,
  appliedOffsetSeconds: OffsetSeconds,
  end: 'start' | 'end',
): PlacedPhoto {
  const index = end === 'start' ? 0 : track.points.length - 1;
  const point = track.points[index];
  if (point === undefined) {
    throw new Error('clampToEndpoint called against an empty track');
  }
  return {
    photoId: photo.id,
    lat: point.lat,
    lon: point.lon,
    elevationM: point.ele,
    method: 'clamped',
    confidence: 'low',
    gapSeconds: null,
    appliedOffsetSeconds,
    distanceAlongM: cumulative[index] ?? 0,
    capturedAt,
  };
}

/**
 * Distance covered over the bracketing segment a photo's instant falls in,
 * for computing its speed. Recomputed from the track rather than threaded
 * through `locate`, which only returns the interpolated point itself.
 */
function estimateSegmentDistance(track: Track, cumulative: number[], instant: number): number {
  const { points } = track;
  if (points.length < 2) return 0;

  let index = points.length;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point !== undefined && point.time >= instant) {
      index = i;
      break;
    }
  }

  if (index <= 0) return 0;
  if (index >= points.length) index = points.length - 1;

  const before = cumulative[index - 1] ?? 0;
  const after = cumulative[index] ?? before;
  return after - before;
}
