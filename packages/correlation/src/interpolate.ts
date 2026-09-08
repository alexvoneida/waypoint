/**
 * Locating a photo's position along a track by its capture instant.
 */

import type { Track, TrackPoint } from './types.ts';

export type LocateResult = {
  lat: number;
  lon: number;
  elevationM: number | null;
  gapSeconds: number;
  method: 'interpolated';
  distanceAlongM: number;
};

/**
 * Index of the first point with `time >= t`, or `points.length` if none.
 * Standard binary-search lower bound: `lo` converges on the answer from
 * above while `hi` stays one past the last candidate.
 */
export function lowerBound(points: TrackPoint[], time: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const point = points[mid];
    if (point !== undefined && point.time < time) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function interpolateElevation(a: TrackPoint, b: TrackPoint, fraction: number): number | null {
  if (a.ele === null || b.ele === null) return null;
  return a.ele + (b.ele - a.ele) * fraction;
}

export function locate(track: Track, instant: number, cumulative: number[]): LocateResult | null {
  const { points } = track;
  if (points.length === 0) return null;
  if (instant < track.startedAt || instant > track.endedAt) return null;

  const index = lowerBound(points, instant);
  const exact = points[index];
  if (exact !== undefined && exact.time === instant) {
    return {
      lat: exact.lat,
      lon: exact.lon,
      elevationM: exact.ele,
      gapSeconds: 0,
      method: 'interpolated',
      distanceAlongM: cumulative[index] ?? 0,
    };
  }

  const before = points[index - 1];
  const after = points[index];
  if (before === undefined || after === undefined) return null;

  const gapSeconds = after.time - before.time;
  const fraction = gapSeconds === 0 ? 0 : (instant - before.time) / gapSeconds;

  const distBefore = cumulative[index - 1] ?? 0;
  const distAfter = cumulative[index] ?? distBefore;

  return {
    lat: before.lat + (after.lat - before.lat) * fraction,
    lon: before.lon + (after.lon - before.lon) * fraction,
    elevationM: interpolateElevation(before, after, fraction),
    gapSeconds,
    method: 'interpolated',
    distanceAlongM: distBefore + (distAfter - distBefore) * fraction,
  };
}
