import { test } from 'node:test';
import assert from 'node:assert/strict';

import { correlate } from '../src/correlate.ts';
import type { Photo, Track, TrackPoint } from '../src/types.ts';

function utc(y: number, m: number, d: number, h: number, min: number, s: number): number {
  return Date.UTC(y, m - 1, d, h, min, s) / 1000;
}

function naiveFor(instant: number, offsetSeconds: number): string {
  const shifted = new Date((instant + offsetSeconds) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

function makeTrack(startedAt: number, endedAt: number, stepSeconds = 60): Track {
  const points: TrackPoint[] = [];
  for (let t = startedAt; t <= endedAt; t += stepSeconds) {
    points.push({ lat: t - startedAt, lon: 0, ele: 100, time: t });
  }
  return { points, startedAt, endedAt, warnings: [] };
}

function photo(id: string, capturedNaive: string | null, extra: Partial<Photo> = {}): Photo {
  return { id, capturedNaive, ...extra };
}

const EDGE_MARGIN_SECONDS = 30;

test('end-to-end placement with a known answer', () => {
  const startedAt = utc(2024, 6, 1, 14, 0, 0);
  const endedAt = utc(2024, 6, 1, 16, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -6 * 3600;

  const photos: Photo[] = [
    photo('a', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset)),
    photo('b', naiveFor(startedAt + 1800, trueOffset)),
    photo('c', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset)),
  ];

  const result = correlate(track, photos, { graceSeconds: 0 });
  assert.equal(result.offset.offsetSeconds, trueOffset);
  assert.equal(result.placed.length, 3);
  assert.equal(result.unplaced.length, 0);

  const b = result.placed.find((p) => p.photoId === 'b');
  assert.ok(b);
  assert.equal(b.lat, 1800);
  assert.equal(b.method, 'interpolated');
  assert.equal(b.capturedAt, startedAt + 1800);
});

test('photos before and after the window become unplaced with the right reason, not clamped', () => {
  const startedAt = utc(2024, 6, 1, 14, 0, 0);
  const endedAt = utc(2024, 6, 1, 16, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -6 * 3600;

  const photos: Photo[] = [
    photo('anchor1', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset)),
    photo('anchor2', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset)),
    photo('early', naiveFor(startedAt - 3600, trueOffset)),
    photo('late', naiveFor(endedAt + 3600, trueOffset)),
  ];

  // forceOffsetSeconds isolates the before/after-track boundary logic from
  // offset search, whose own grace tolerance would otherwise let a
  // neighbouring candidate tie with the true offset.
  const result = correlate(track, photos, { forceOffsetSeconds: trueOffset, graceSeconds: 900 });

  const early = result.unplaced.find((p) => p.photoId === 'early');
  assert.ok(early);
  assert.equal(early.reason, 'before-track');
  assert.equal(early.outsideBySeconds, 3600);

  const late = result.unplaced.find((p) => p.photoId === 'late');
  assert.ok(late);
  assert.equal(late.reason, 'after-track');
  assert.equal(late.outsideBySeconds, 3600);

  assert.ok(!result.placed.some((p) => p.photoId === 'early' || p.photoId === 'late'));
});

test('a photo inside the grace window is clamped to the nearest endpoint', () => {
  const startedAt = utc(2024, 6, 1, 14, 0, 0);
  const endedAt = utc(2024, 6, 1, 16, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -6 * 3600;

  const photos: Photo[] = [
    photo('grace', naiveFor(endedAt + 500, trueOffset)),
  ];

  // forceOffsetSeconds isolates the clamping behaviour from offset search,
  // whose own grace tolerance would otherwise make this photo's placement
  // ambiguous evidence for the search itself.
  const result = correlate(track, photos, { forceOffsetSeconds: trueOffset, graceSeconds: 900 });
  const grace = result.placed.find((p) => p.photoId === 'grace');
  assert.ok(grace);
  assert.equal(grace.method, 'clamped');
  assert.equal(grace.confidence, 'low');
  assert.equal(grace.gapSeconds, null);
  assert.equal(grace.lat, track.points[track.points.length - 1]!.lat);
  assert.equal(grace.lon, track.points[track.points.length - 1]!.lon);
});

test('mixed batch of camera photos and exifPosition phone photos resolves with no seam', () => {
  const startedAt = utc(2024, 6, 1, 14, 0, 0);
  const endedAt = utc(2024, 6, 1, 16, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -6 * 3600;

  const photos: Photo[] = [
    photo('anchor1', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset)),
    photo('anchor2', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset)),
    photo('camera', naiveFor(startedAt + 1800, trueOffset)),
    photo('phone', naiveFor(startedAt + 1900, trueOffset), { exifPosition: { lat: 42, lon: -71, ele: 10 } }),
  ];

  const result = correlate(track, photos, { graceSeconds: 0 });
  assert.equal(result.offset.offsetSeconds, trueOffset);
  assert.equal(result.placed.length, 4);

  const phone = result.placed.find((p) => p.photoId === 'phone');
  assert.ok(phone);
  assert.equal(phone.method, 'exif');
  assert.equal(phone.confidence, 'high');
  assert.equal(phone.gapSeconds, null);
  assert.equal(phone.lat, 42);
  assert.equal(phone.lon, -71);
  assert.equal(phone.elevationM, 10);
  assert.equal(phone.capturedAt, startedAt + 1900);

  // Placed list is ordered by capturedAt regardless of method.
  const order = result.placed.map((p) => p.photoId);
  assert.deepEqual(order, ['anchor1', 'camera', 'phone', 'anchor2']);
});

test('exifPosition photos do not influence offset scoring', () => {
  const startedAt = utc(2024, 6, 1, 14, 0, 0);
  const endedAt = utc(2024, 6, 1, 16, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -6 * 3600;
  const wrongOffset = -6 * 3600 + 3600; // would place the phone photo, not the anchors

  const photos: Photo[] = [
    photo('anchor1', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset)),
    photo('anchor2', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset)),
    photo('phone', naiveFor(startedAt + 1800, wrongOffset), { exifPosition: { lat: 1, lon: 2 } }),
  ];

  const result = correlate(track, photos, { graceSeconds: 0 });
  assert.equal(result.offset.offsetSeconds, trueOffset);
  assert.equal(result.offset.totalCount, 2);
});

test('appliedOffsetSeconds reflects a per-photo cameraOffsetSeconds', () => {
  const startedAt = utc(2024, 6, 1, 14, 0, 0);
  const endedAt = utc(2024, 6, 1, 16, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -6 * 3600;
  const cameraOffsetSeconds = 120; // this body's clock runs 2 minutes fast

  const photos: Photo[] = [
    photo('anchor1', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset)),
    photo('anchor2', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset)),
    photo('drifted', naiveFor(startedAt + 1800 + cameraOffsetSeconds, trueOffset), { cameraOffsetSeconds }),
  ];

  const result = correlate(track, photos, { graceSeconds: 0 });
  const drifted = result.placed.find((p) => p.photoId === 'drifted');
  assert.ok(drifted);
  assert.equal(drifted.appliedOffsetSeconds, trueOffset + cameraOffsetSeconds);
  assert.equal(drifted.capturedAt, startedAt + 1800);
});

test('a track crossing midnight UTC resolves correctly', () => {
  const startedAt = utc(2024, 6, 1, 22, 0, 0);
  const endedAt = utc(2024, 6, 2, 2, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -5 * 3600;

  const photos: Photo[] = [
    photo('anchor1', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset)),
    photo('anchor2', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset)),
    photo('mid', naiveFor(utc(2024, 6, 2, 0, 0, 0), trueOffset)),
  ];

  const result = correlate(track, photos, { graceSeconds: 0 });
  assert.equal(result.offset.offsetSeconds, trueOffset);
  const mid = result.placed.find((p) => p.photoId === 'mid');
  assert.ok(mid);
  assert.equal(mid.capturedAt, utc(2024, 6, 2, 0, 0, 0));
});

test('an activity spanning two calendar days resolves correctly', () => {
  const startedAt = utc(2024, 6, 1, 8, 0, 0);
  const endedAt = utc(2024, 6, 2, 20, 0, 0);
  const track = makeTrack(startedAt, endedAt, 3600);
  const trueOffset = -7 * 3600;

  const photos: Photo[] = [
    photo('anchor1', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset)),
    photo('anchor2', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset)),
    photo('day2', naiveFor(utc(2024, 6, 2, 10, 0, 0), trueOffset)),
  ];

  const result = correlate(track, photos, { graceSeconds: 0 });
  assert.equal(result.offset.offsetSeconds, trueOffset);
  assert.equal(result.placed.length, 3);
});

test('forceOffsetSeconds bypasses the search', () => {
  const startedAt = utc(2024, 6, 1, 14, 0, 0);
  const endedAt = utc(2024, 6, 1, 16, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -6 * 3600;
  const forcedOffset = -5 * 3600; // deliberately "wrong" relative to the photos

  const photos: Photo[] = [
    photo('a', naiveFor(startedAt + 1800, trueOffset)),
  ];

  const result = correlate(track, photos, { forceOffsetSeconds: forcedOffset, graceSeconds: 0 });
  assert.equal(result.offset.offsetSeconds, forcedOffset);

  // With the forced offset, the naive time resolves an hour earlier than the true instant.
  const expectedInstant = startedAt + 1800 - 3600;
  const found = result.placed.find((p) => p.photoId === 'a');
  const foundUnplaced = result.unplaced.find((p) => p.photoId === 'a');
  if (found) {
    assert.equal(found.capturedAt, expectedInstant);
  } else if (foundUnplaced) {
    assert.equal(foundUnplaced.capturedAt, expectedInstant);
  } else {
    assert.fail('photo a should be either placed or unplaced');
  }
});

test('no offset resolved leaves every timestamped photo unplaced with reason no-offset-resolved', () => {
  const startedAt = utc(2024, 1, 1, 0, 0, 0);
  const endedAt = utc(2024, 1, 1, 1, 0, 0);
  const track = makeTrack(startedAt, endedAt);

  const photos: Photo[] = [photo('a', '2030-01-01T00:00:00')];

  const result = correlate(track, photos);
  assert.equal(result.placed.length, 0);
  assert.equal(result.unplaced.length, 1);
  assert.equal(result.unplaced[0]!.reason, 'no-offset-resolved');
});

test('a photo with no timestamp is unplaced with reason no-timestamp', () => {
  const startedAt = utc(2024, 6, 1, 14, 0, 0);
  const endedAt = utc(2024, 6, 1, 16, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -6 * 3600;

  const photos: Photo[] = [
    photo('anchor1', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset)),
    photo('anchor2', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset)),
    photo('no-time', null),
  ];

  const result = correlate(track, photos, { graceSeconds: 0 });
  const noTime = result.unplaced.find((p) => p.photoId === 'no-time');
  assert.ok(noTime);
  assert.equal(noTime.reason, 'no-timestamp');
  assert.equal(noTime.capturedAt, null);
});
