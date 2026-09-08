import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lowerBound, locate } from '../src/interpolate.ts';
import { cumulativeDistances } from '../src/geo.ts';
import type { Track, TrackPoint } from '../src/types.ts';

function point(time: number, lat: number, lon: number, ele: number | null = 100): TrackPoint {
  return { time, lat, lon, ele };
}

const points: TrackPoint[] = [
  point(1000, 0, 0),
  point(1010, 0, 1),
  point(1020, 0, 2),
  point(1030, 0, 3),
];

function makeTrack(pts: TrackPoint[]): Track {
  return {
    points: pts,
    startedAt: pts[0]!.time,
    endedAt: pts[pts.length - 1]!.time,
    warnings: [],
  };
}

test('lowerBound: exact match on first point', () => {
  assert.equal(lowerBound(points, 1000), 0);
});

test('lowerBound: exact match on last point', () => {
  assert.equal(lowerBound(points, 1030), 3);
});

test('lowerBound: before first point', () => {
  assert.equal(lowerBound(points, 500), 0);
});

test('lowerBound: after last point', () => {
  assert.equal(lowerBound(points, 2000), points.length);
});

test('lowerBound: between two points returns the later one', () => {
  assert.equal(lowerBound(points, 1015), 2);
});

test('lowerBound: exact match on an interior point', () => {
  assert.equal(lowerBound(points, 1020), 2);
});

test('locate: exact hit on a track point returns it exactly, no drift', () => {
  const track = makeTrack(points);
  const cumulative = cumulativeDistances(points);
  const result = locate(track, 1010, cumulative);
  assert.ok(result !== null);
  assert.equal(result.lat, 0);
  assert.equal(result.lon, 1);
  assert.equal(result.gapSeconds, 0);
  assert.equal(result.method, 'interpolated');
});

test('locate: interpolates between bracketing points by hand-computed fraction', () => {
  const pts: TrackPoint[] = [point(0, 0, 0, 0), point(100, 10, 20, 200)];
  const track = makeTrack(pts);
  const cumulative = cumulativeDistances(pts);

  const result = locate(track, 25, cumulative);
  assert.ok(result !== null);
  // fraction = 25/100 = 0.25
  assert.ok(Math.abs(result.lat - 2.5) < 1e-9);
  assert.ok(Math.abs(result.lon - 5) < 1e-9);
  assert.ok(Math.abs((result.elevationM ?? NaN) - 50) < 1e-9);
  assert.equal(result.gapSeconds, 100);
});

test('locate: null elevation on either bracketing point propagates null', () => {
  const pts: TrackPoint[] = [point(0, 0, 0, null), point(100, 10, 10, 200)];
  const track = makeTrack(pts);
  const cumulative = cumulativeDistances(pts);
  const result = locate(track, 50, cumulative);
  assert.ok(result !== null);
  assert.equal(result.elevationM, null);
});

test('locate: outside the track range returns null', () => {
  const track = makeTrack(points);
  const cumulative = cumulativeDistances(points);
  assert.equal(locate(track, 999, cumulative), null);
  assert.equal(locate(track, 1031, cumulative), null);
});

test('locate: distanceAlongM interpolates along the same fraction as time', () => {
  const pts: TrackPoint[] = [point(0, 0, 0), point(100, 0, 1)];
  const track = makeTrack(pts);
  const cumulative = cumulativeDistances(pts);
  const full = cumulative[1]!;
  const result = locate(track, 50, cumulative);
  assert.ok(result !== null);
  assert.ok(Math.abs(result.distanceAlongM - full / 2) < 1e-6);
});
