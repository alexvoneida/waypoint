import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferOffset } from '../src/offset.ts';
import { correlate } from '../src/correlate.ts';
import type { Photo, Track, TrackPoint } from '../src/types.ts';

const HOUR = 3600;
const DENVER_SUMMER = -6 * HOUR;

/** A track running west along a line of latitude, one point a minute. */
function buildTrack(startUtc: number, minutes: number): Track {
  const points: TrackPoint[] = [];
  for (let i = 0; i <= minutes; i++) {
    points.push({ lat: 38, lon: -107.8 - i * 0.001, ele: 3000 + i, time: startUtc + i * 60 });
  }
  return {
    points,
    startedAt: startUtc,
    endedAt: startUtc + minutes * 60,
    warnings: [],
  };
}

/** `atUtc` is when the photograph was really taken; the naive value is what the
 *  camera wrote, which is that instant read in the given zone. */
function photoAt(id: string, atUtc: number, zoneOffset: number, exifOffset?: number): Photo {
  const naive = new Date((atUtc + zoneOffset) * 1000).toISOString().slice(0, 19);
  const photo: Photo = { id, capturedNaive: naive };
  if (exifOffset !== undefined) photo.exifOffsetSeconds = exifOffset;
  return photo;
}

const START = Date.parse('2026-08-22T12:50:00Z') / 1000;

test('photographs bracketing the activity determine the offset outright', () => {
  const track = buildTrack(START, 330);
  const photos = [
    photoAt('a', START + 60, DENVER_SUMMER),
    photoAt('b', START + 329 * 60, DENVER_SUMMER),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 0 });

  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.admissibleOffsets, [DENVER_SUMMER]);
  assert.equal(result.offsetSeconds, DENVER_SUMMER);
  assert.equal(result.selectedBy, 'search');
});

/**
 * The grace period sets a floor on how sharply the search can ever resolve.
 * Candidates are spaced 15 minutes apart and grace is 15 minutes, so even
 * photographs sitting exactly on the window edges leave the neighbouring
 * candidates admissible. No amount of photographic coverage removes this;
 * only a smaller grace or a prior does.
 */
test('a 15-minute grace keeps the neighbouring candidates admissible', () => {
  const track = buildTrack(START, 330);
  const photos = [
    photoAt('a', START, DENVER_SUMMER),
    photoAt('b', START + 330 * 60, DENVER_SUMMER),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 900 });

  assert.deepEqual(result.admissibleOffsets, [
    DENVER_SUMMER - 900,
    DENVER_SUMMER,
    DENVER_SUMMER + 900,
  ]);
  assert.equal(result.ambiguous, true);
  // The midpoint of a symmetric set is the truth, so the fallback is right here.
  assert.equal(result.offsetSeconds, DENVER_SUMMER);
});

test('photographs clustered mid-activity leave many offsets admissible', () => {
  const track = buildTrack(START, 330);
  const photos = [
    photoAt('a', START + 153 * 60, DENVER_SUMMER),
    photoAt('b', START + 160 * 60, DENVER_SUMMER),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 900 });

  assert.equal(result.ambiguous, true);
  assert.ok(result.admissibleOffsets.length > 10);
  // The weaker invariant that always holds: the truth is in the set.
  assert.ok(result.admissibleOffsets.includes(DENVER_SUMMER));
});

test('the EXIF offset selects within the admissible set', () => {
  const track = buildTrack(START, 330);
  const photos = [
    photoAt('a', START + 153 * 60, DENVER_SUMMER, DENVER_SUMMER),
    photoAt('b', START + 160 * 60, DENVER_SUMMER, DENVER_SUMMER),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 900 });

  assert.equal(result.selectedBy, 'exif-prior');
  assert.equal(result.offsetSeconds, DENVER_SUMMER);
  assert.equal(result.agreesWithExif, true);
});

test('an EXIF offset the track rules out is refused', () => {
  const track = buildTrack(START, 330);
  const impossible = 9 * HOUR;
  const photos = [
    photoAt('a', START + 153 * 60, DENVER_SUMMER, impossible),
    photoAt('b', START + 160 * 60, DENVER_SUMMER, impossible),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 900 });

  assert.equal(result.agreesWithExif, false);
  assert.notEqual(result.offsetSeconds, impossible);
  assert.ok(!result.admissibleOffsets.includes(impossible));
  assert.equal(result.selectedBy, 'search');
});

test('with no usable tag the midpoint is taken and flagged', () => {
  const track = buildTrack(START, 330);
  const photos = [
    photoAt('a', START + 153 * 60, DENVER_SUMMER),
    photoAt('b', START + 160 * 60, DENVER_SUMMER),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 900 });
  const set = result.admissibleOffsets;

  assert.equal(result.ambiguous, true);
  assert.equal(result.selectedBy, 'search');
  assert.equal(result.offsetSeconds, set[Math.floor(set.length / 2)]);
});

test('photographs from bodies set to different zones make the tag no evidence', () => {
  const track = buildTrack(START, 330);
  const photos = [
    photoAt('a', START + 153 * 60, DENVER_SUMMER, DENVER_SUMMER),
    photoAt('b', START + 160 * 60, DENVER_SUMMER, -5 * HOUR),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 900 });

  assert.equal(result.exifOffsetSeconds, null);
  assert.equal(result.agreesWithExif, null);
  assert.equal(result.selectedBy, 'search');
});

/**
 * The specific silent failure that a "closest to zero" tiebreak reintroduces.
 * Every photograph still lands on the route, just the wrong part of it, so
 * nothing else in the suite would catch it.
 */
test('a Colorado hike never infers an offset near Greenwich', () => {
  const track = buildTrack(START, 330);
  const photos = [
    photoAt('a', START + 153 * 60, DENVER_SUMMER, DENVER_SUMMER),
    photoAt('b', START + 160 * 60, DENVER_SUMMER, DENVER_SUMMER),
  ];

  const result = inferOffset(photos, track, { graceSeconds: 900 });

  assert.equal(result.offsetSeconds, DENVER_SUMMER);
  assert.ok(
    Math.abs(result.offsetSeconds as number) > 3 * HOUR,
    `inferred UTC${(result.offsetSeconds as number) / HOUR}, which is the Greenwich bias`,
  );
});

test('an ambiguous offset caps a placed photograph at medium', () => {
  const track = buildTrack(START, 330);
  const photos = [
    photoAt('a', START + 153 * 60, DENVER_SUMMER, DENVER_SUMMER),
    photoAt('b', START + 160 * 60, DENVER_SUMMER, DENVER_SUMMER),
  ];

  const result = correlate(track, photos, { graceSeconds: 900 });

  assert.equal(result.offset.ambiguous, true);
  assert.equal(result.placed.length, 2);
  for (const placed of result.placed) {
    assert.notEqual(placed.confidence, 'high');
  }
});

test('the same photographs score high once the offset is determined', () => {
  const track = buildTrack(START, 330);
  const photos = [
    photoAt('a', START, DENVER_SUMMER),
    photoAt('b', START + 330 * 60, DENVER_SUMMER),
  ];

  // A forced offset is a determination, so nothing is capped.
  const result = correlate(track, photos, { forceOffsetSeconds: DENVER_SUMMER });

  assert.equal(result.offset.ambiguous, false);
  assert.ok(result.placed.some((placed) => placed.confidence === 'high'));
});

test('a photograph carrying its own coordinates is not capped', () => {
  const track = buildTrack(START, 330);
  const photos: Photo[] = [
    photoAt('a', START + 153 * 60, DENVER_SUMMER, DENVER_SUMMER),
    photoAt('b', START + 160 * 60, DENVER_SUMMER, DENVER_SUMMER),
    {
      id: 'phone',
      capturedNaive: '2026-08-22T09:30:00',
      exifPosition: { lat: 38.0, lon: -107.85 },
    },
  ];

  const result = correlate(track, photos, { graceSeconds: 900 });
  const phone = result.placed.find((placed) => placed.photoId === 'phone');

  assert.equal(result.offset.ambiguous, true);
  assert.equal(phone?.method, 'exif');
  assert.equal(phone?.confidence, 'high');
});
