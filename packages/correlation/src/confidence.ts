/**
 * Scoring how much to trust a placed photo's position.
 *
 * A real Garmin hike with no signal loss measured a 4 s median interval
 * between track points, with 8 intervals over 15 s and a maximum of 18 s.
 * `medium` is therefore routine, not a warning sign - it is what an ordinary
 * hike with brief signal gaps looks like.
 */

import type { Confidence } from './types.ts';

export const GAP_HIGH_MAX_SECONDS = 15;
export const GAP_MEDIUM_MAX_SECONDS = 120;

export const SPEED_HIGH_MAX_MPS = 1;
export const SPEED_MEDIUM_MAX_MPS = 3;

export type ConfidenceInput = {
  gapSeconds: number | null;
  speedMetresPerSecond: number;
};

function scoreGap(gapSeconds: number | null): Confidence {
  if (gapSeconds === null) return 'low';
  if (gapSeconds < GAP_HIGH_MAX_SECONDS) return 'high';
  if (gapSeconds <= GAP_MEDIUM_MAX_SECONDS) return 'medium';
  return 'low';
}

function scoreSpeed(speedMetresPerSecond: number): Confidence {
  if (speedMetresPerSecond < SPEED_HIGH_MAX_MPS) return 'high';
  if (speedMetresPerSecond <= SPEED_MEDIUM_MAX_MPS) return 'medium';
  return 'low';
}

/**
 * Speed over a bracketing segment. A zero-duration segment (two track points
 * sharing a timestamp) has no meaningful rate, and dividing by zero would
 * produce NaN or Infinity rather than a comparable value, so it is scored as
 * stationary instead.
 */
export function metresPerSecond(distanceM: number, gapSeconds: number): number {
  if (gapSeconds <= 0) return 0;
  return distanceM / gapSeconds;
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function scoreConfidence(input: ConfidenceInput): Confidence {
  const gapScore = scoreGap(input.gapSeconds);
  const speedScore = scoreSpeed(input.speedMetresPerSecond);
  return RANK[gapScore] <= RANK[speedScore] ? gapScore : speedScore;
}
