import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inferOffset, CANDIDATE_OFFSETS } from '../src/offset.ts';
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
    points.push({ lat: 0, lon: (t - startedAt) / 1000, ele: 0, time: t });
  }
  return { points, startedAt, endedAt, warnings: [] };
}

function photo(id: string, capturedNaive: string | null, extra: Partial<Photo> = {}): Photo {
  return { id, capturedNaive, ...extra };
}

// A margin well under the 900s candidate step: with graceSeconds 0, shifting
// by even one candidate step pushes a photo this close to a boundary out of
// the window, so only the true offset keeps every anchor photo placed. This
// is what makes offset recovery in these tests exact rather than tied.
const EDGE_MARGIN_SECONDS = 30;

test('recovers a known offset exactly', () => {
  const startedAt = utc(2024, 6, 1, 14, 0, 0);
  const endedAt = utc(2024, 6, 1, 18, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -6 * 3600; // UTC-6

  const photos: Photo[] = [
    photo('a', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset)),
    photo('b', naiveFor(startedAt + 3600, trueOffset)),
    photo('c', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset)),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 0 });
  assert.equal(result.offsetSeconds, trueOffset);
  assert.equal(result.placedCount, 3);
});

test('spread tiebreak picks the true offset over an adjacent offset that bunches photos at a boundary', () => {
  // Window: [1000, 11000). A distractor photo sits just outside the true
  // window and a genuine photo sits just inside the far edge. Shifting by
  // one candidate step (900s) swaps which of the two is excluded: the
  // adjacent offset admits the distractor instead of the far edge photo,
  // holding placedCount at 4 for both candidates but shrinking the span of
  // the placed photos - the "bunched against one boundary" case the spread
  // tiebreak exists for.
  const startedAt = 1000;
  const endedAt = 11000;
  const track: Track = { points: [{ lat: 0, lon: 0, ele: null, time: startedAt }, { lat: 0, lon: 1, ele: null, time: endedAt }], startedAt, endedAt, warnings: [] };
  const trueOffset = -21600;

  const trueInstants = [500, startedAt + 100, 5000, 7000, endedAt - 100];
  const photos: Photo[] = trueInstants.map((instant, i) => photo(`p${i}`, naiveFor(instant, trueOffset)));

  const result = inferOffset(photos, track, { graceSeconds: 0 });
  assert.equal(result.offsetSeconds, trueOffset);
  assert.equal(result.placedCount, 4);
});

test('recovers a quarter-hour offset (Kathmandu, +05:45)', () => {
  const startedAt = utc(2024, 3, 10, 6, 0, 0);
  const endedAt = utc(2024, 3, 10, 10, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = 5 * 3600 + 45 * 60;

  const photos: Photo[] = [
    photo('a', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset)),
    photo('b', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset)),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 0 });
  assert.equal(result.offsetSeconds, trueOffset);
});

test('no candidate places any photo: offsetSeconds is null, not a guess', () => {
  const startedAt = utc(2024, 1, 1, 0, 0, 0);
  const endedAt = utc(2024, 1, 1, 1, 0, 0);
  const track = makeTrack(startedAt, endedAt);

  const photos: Photo[] = [photo('a', '2030-01-01T00:00:00')];

  const result = inferOffset(photos, track);
  assert.equal(result.offsetSeconds, null);
  assert.equal(result.placedCount, 0);
});

test('agreesWithExif is true when the winning offset matches agreeing EXIF offsets', () => {
  const startedAt = utc(2024, 6, 1, 12, 0, 0);
  const endedAt = utc(2024, 6, 1, 14, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -7 * 3600;

  const photos: Photo[] = [
    photo('a', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset), { exifOffsetSeconds: trueOffset }),
    photo('b', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset), { exifOffsetSeconds: trueOffset }),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 0 });
  assert.equal(result.offsetSeconds, trueOffset);
  assert.equal(result.exifOffsetSeconds, trueOffset);
  assert.equal(result.agreesWithExif, true);
});

test('agreesWithExif is false when EXIF offsets disagree with the winning offset', () => {
  const startedAt = utc(2024, 6, 1, 12, 0, 0);
  const endedAt = utc(2024, 6, 1, 14, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -7 * 3600;

  const photos: Photo[] = [
    photo('a', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset), { exifOffsetSeconds: -6 * 3600 }),
    photo('b', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset), { exifOffsetSeconds: -6 * 3600 }),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 0 });
  assert.equal(result.offsetSeconds, trueOffset);
  assert.equal(result.exifOffsetSeconds, -6 * 3600);
  assert.equal(result.agreesWithExif, false);
});

test('exifOffsetSeconds is null when the carried offsets disagree with each other', () => {
  const startedAt = utc(2024, 6, 1, 12, 0, 0);
  const endedAt = utc(2024, 6, 1, 14, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -7 * 3600;

  const photos: Photo[] = [
    photo('a', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset), { exifOffsetSeconds: -6 * 3600 }),
    photo('b', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset), { exifOffsetSeconds: -7 * 3600 }),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 0 });
  assert.equal(result.exifOffsetSeconds, null);
  assert.equal(result.agreesWithExif, null);
});

test('photos with null capturedNaive are excluded from scoring', () => {
  const startedAt = utc(2024, 6, 1, 12, 0, 0);
  const endedAt = utc(2024, 6, 1, 14, 0, 0);
  const track = makeTrack(startedAt, endedAt);
  const trueOffset = -7 * 3600;

  const photos: Photo[] = [
    photo('a', naiveFor(startedAt + EDGE_MARGIN_SECONDS, trueOffset)),
    photo('b', naiveFor(endedAt - EDGE_MARGIN_SECONDS, trueOffset)),
    photo('c', null),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 0 });
  assert.equal(result.totalCount, 2);
  assert.equal(result.offsetSeconds, trueOffset);
});

// Small seeded PRNG (mulberry32) so a failing property test is reproducible.
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: recovers a randomly chosen true offset for a random track and photos', () => {
  const seed = 0xc0ffee;
  const rand = mulberry32(seed);

  for (let trial = 0; trial < 300; trial++) {
    const startedAt = utc(2024, 1, 1, 0, 0, 0) + Math.floor(rand() * 1e8);
    const durationSeconds = 3600 + Math.floor(rand() * 5 * 3600);
    const endedAt = startedAt + durationSeconds;
    const track = makeTrack(startedAt, endedAt, 30);

    const trueOffset = CANDIDATE_OFFSETS[Math.floor(rand() * CANDIDATE_OFFSETS.length)]!;

    // Anchor a photo close to each edge (well inside the candidate step of
    // 900s) so no other offset can tie on placedCount, plus a few more
    // scattered through the middle.
    const middleCount = 2 + Math.floor(rand() * 4);
    const trueInstants = [startedAt + EDGE_MARGIN_SECONDS, endedAt - EDGE_MARGIN_SECONDS];
    for (let i = 0; i < middleCount; i++) {
      trueInstants.push(startedAt + Math.floor(rand() * durationSeconds));
    }

    const photos: Photo[] = trueInstants.map((instant, i) => photo(`p${i}`, naiveFor(instant, trueOffset)));

    const result = inferOffset(photos, track, { graceSeconds: 0 });
    assert.equal(
      result.offsetSeconds,
      trueOffset,
      `seed=${seed} trial=${trial} expected ${trueOffset} got ${result.offsetSeconds}`,
    );
  }
});
