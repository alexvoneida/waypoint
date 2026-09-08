import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseGpx } from '../src/gpx.ts';
import { GpxParseError } from '../src/types.ts';

// gpxWrap puts the xml declaration on line 1 and <gpx> on line 2, so
// trackBody's first line is always line 3. Fixtures below never start
// trackBody with a leading blank line, so line numbers can be counted by eye.
function gpxWrap(trackBody: string): string {
  return `<?xml version="1.0"?>\n<gpx version="1.1">\n${trackBody}\n</gpx>\n`;
}

test('parses a minimal well-formed track', () => {
  const xml = gpxWrap(
    `<trk><trkseg>
<trkpt lat="10" lon="20"><ele>100</ele><time>2026-08-22T12:00:00Z</time></trkpt>
<trkpt lat="11" lon="21"><ele>200</ele><time>2026-08-22T12:00:10Z</time></trkpt>
</trkseg></trk>`,
  );

  const track = parseGpx(xml);

  assert.equal(track.points.length, 2);
  assert.deepEqual(track.points[0], { lat: 10, lon: 20, ele: 100, time: Date.parse('2026-08-22T12:00:00Z') / 1000 });
  assert.deepEqual(track.points[1], { lat: 11, lon: 21, ele: 200, time: Date.parse('2026-08-22T12:00:10Z') / 1000 });
  assert.equal(track.startedAt, track.points[0]!.time);
  assert.equal(track.endedAt, track.points[1]!.time);
  assert.deepEqual(track.warnings, []);
});

test('concatenates multiple trkseg elements in order', () => {
  const xml = gpxWrap(
    `<trk>
<trkseg>
<trkpt lat="0" lon="0"><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lat="1" lon="1"><time>2026-01-01T00:00:10Z</time></trkpt>
</trkseg>
<trkseg>
<trkpt lat="2" lon="2"><time>2026-01-01T00:00:20Z</time></trkpt>
</trkseg>
</trk>`,
  );

  const track = parseGpx(xml);

  assert.equal(track.points.length, 3);
  assert.deepEqual(
    track.points.map((p) => p.lat),
    [0, 1, 2],
  );
});

test('concatenates multiple trk elements in order', () => {
  const xml = gpxWrap(
    `<trk><trkseg>
<trkpt lat="0" lon="0"><time>2026-01-01T00:00:00Z</time></trkpt>
</trkseg></trk>
<trk><trkseg>
<trkpt lat="5" lon="5"><time>2026-01-01T00:00:10Z</time></trkpt>
</trkseg></trk>`,
  );

  const track = parseGpx(xml);

  assert.equal(track.points.length, 2);
  assert.deepEqual(
    track.points.map((p) => p.lat),
    [0, 5],
  );
});

test('handles varied attribute order, quoting, extra attributes, and self-closing form', () => {
  const xml = gpxWrap(
    `<trk><trkseg>
<trkpt lon="20" lat="10" extra="ignored"><ele>100</ele><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lat='11' lon='21' foo="bar"><ele>200</ele><time>2026-01-01T00:00:10Z</time></trkpt>
<trkpt lat="12" lon="22" some-flag="x" />
</trkseg></trk>`,
  );

  // The self-closing point has no <time> child, which is fatal on its own -
  // that is covered by the dedicated "missing time" test below. Here we only
  // exercise attribute parsing, so drop the timeless point from this fixture.
  const xmlWithTimes = gpxWrap(
    `<trk><trkseg>
<trkpt lon="20" lat="10" extra="ignored"><ele>100</ele><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lat='11' lon='21' foo="bar"><ele>200</ele><time>2026-01-01T00:00:10Z</time></trkpt>
<trkpt lat="12" lon="22" some-flag="x"><time>2026-01-01T00:00:20Z</time></trkpt>
</trkseg></trk>`,
  );

  assert.throws(() => parseGpx(xml), GpxParseError);

  const track = parseGpx(xmlWithTimes);
  assert.equal(track.points.length, 3);
  assert.deepEqual(track.points[0]!.lat, 10);
  assert.deepEqual(track.points[0]!.lon, 20);
  assert.deepEqual(track.points[1]!.lat, 11);
  assert.deepEqual(track.points[1]!.lon, 21);
  assert.deepEqual(track.points[2]!.lat, 12);
  assert.deepEqual(track.points[2]!.lon, 22);
});

test('tolerates namespace-prefixed tags', () => {
  const xml = gpxWrap(
    `<gpx:trk><gpx:trkseg>
<gpx:trkpt lat="1" lon="2"><gpx:ele>50</gpx:ele><gpx:time>2026-01-01T00:00:00Z</gpx:time></gpx:trkpt>
<gpx:trkpt lat="3" lon="4"><gpx:ele>60</gpx:ele><gpx:time>2026-01-01T00:00:10Z</gpx:time></gpx:trkpt>
</gpx:trkseg></gpx:trk>`,
  );

  const track = parseGpx(xml);

  assert.equal(track.points.length, 2);
  assert.equal(track.points[0]!.ele, 50);
  assert.equal(track.points[1]!.ele, 60);
});

test('fractional seconds and numeric offsets parse to the same epoch second as Z', () => {
  const xml = gpxWrap(
    `<trk><trkseg>
<trkpt lat="0" lon="0"><time>2026-08-22T12:50:29Z</time></trkpt>
<trkpt lat="1" lon="1"><time>2026-08-22T12:50:30.000Z</time></trkpt>
<trkpt lat="2" lon="2"><time>2026-08-22T12:50:31+00:00</time></trkpt>
</trkseg></trk>`,
  );

  const track = parseGpx(xml);

  const base = Date.parse('2026-08-22T12:50:29Z') / 1000;
  assert.equal(track.points[0]!.time, base);
  assert.equal(track.points[1]!.time, base + 1);
  assert.equal(track.points[2]!.time, base + 2);
});

test('missing elevation yields null and exactly one warning for the whole track', () => {
  const xml = gpxWrap(
    `<trk><trkseg>
<trkpt lat="0" lon="0"><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lat="1" lon="1"><time>2026-01-01T00:00:10Z</time></trkpt>
<trkpt lat="2" lon="2"><time>2026-01-01T00:00:20Z</time></trkpt>
</trkseg></trk>`,
  );

  const track = parseGpx(xml);

  assert.deepEqual(
    track.points.map((p) => p.ele),
    [null, null, null],
  );
  const elevationWarnings = track.warnings.filter((w) => w.includes('elevation'));
  assert.equal(elevationWarnings.length, 1);
});

test('wpt elements outside the track are ignored', () => {
  const xml = gpxWrap(
    `<wpt lat="99" lon="99"><time>2026-01-01T00:00:00Z</time></wpt>
<trk><trkseg>
<trkpt lat="0" lon="0"><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lat="1" lon="1"><time>2026-01-01T00:00:10Z</time></trkpt>
</trkseg></trk>`,
  );

  const track = parseGpx(xml);

  assert.equal(track.points.length, 2);
  assert.ok(track.points.every((p) => p.lat !== 99));
});

test('non-monotonic timestamps are sorted ascending with a warning', () => {
  const xml = gpxWrap(
    `<trk><trkseg>
<trkpt lat="0" lon="0"><time>2026-01-01T00:00:20Z</time></trkpt>
<trkpt lat="1" lon="1"><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lat="2" lon="2"><time>2026-01-01T00:00:10Z</time></trkpt>
</trkseg></trk>`,
  );

  const track = parseGpx(xml);

  const times = track.points.map((p) => p.time);
  const sortedTimes = [...times].sort((a, b) => a - b);
  assert.deepEqual(times, sortedTimes);
  assert.deepEqual(
    track.points.map((p) => p.lat),
    [1, 2, 0],
  );
  assert.ok(track.warnings.some((w) => w.includes('out of chronological order')));
});

test('duplicate timestamps are dropped, keeping the first, with a warning', () => {
  const xml = gpxWrap(
    `<trk><trkseg>
<trkpt lat="0" lon="0"><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lat="9" lon="99"><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lat="1" lon="1"><time>2026-01-01T00:00:10Z</time></trkpt>
</trkseg></trk>`,
  );

  const track = parseGpx(xml);

  assert.equal(track.points.length, 2);
  assert.equal(track.points[0]!.lat, 0);
  assert.ok(track.warnings.some((w) => w.includes('duplicate timestamps')));
});

test('throws when there are no trkpt elements at all', () => {
  const xml = gpxWrap('<trk><trkseg></trkseg></trk>');
  assert.throws(() => parseGpx(xml), GpxParseError);
});

test('throws with the correct line number for a missing lat', () => {
  // Line 1: xml decl, line 2: <gpx>, line 3: <trk><trkseg>, line 4: good
  // point, line 5: the point missing lat.
  const xml = gpxWrap(
    `<trk><trkseg>
<trkpt lat="0" lon="0"><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lon="5"><time>2026-01-01T00:00:10Z</time></trkpt>
</trkseg></trk>`,
  );

  try {
    parseGpx(xml);
    assert.fail('expected parseGpx to throw');
  } catch (error) {
    assert.ok(error instanceof GpxParseError);
    assert.equal((error as InstanceType<typeof GpxParseError>).line, 5);
  }
});

test('throws with the correct line number for an out-of-range lat several lines in', () => {
  // Line 1: xml decl, line 2: <gpx>, line 3: <trk><trkseg>, lines 4-6: good
  // points, line 7: the out-of-range point.
  const xml = gpxWrap(
    `<trk><trkseg>
<trkpt lat="0" lon="0"><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lat="1" lon="1"><time>2026-01-01T00:00:10Z</time></trkpt>
<trkpt lat="1" lon="2"><time>2026-01-01T00:00:20Z</time></trkpt>
<trkpt lat="200" lon="3"><time>2026-01-01T00:00:30Z</time></trkpt>
</trkseg></trk>`,
  );

  try {
    parseGpx(xml);
    assert.fail('expected parseGpx to throw');
  } catch (error) {
    assert.ok(error instanceof GpxParseError);
    assert.equal((error as InstanceType<typeof GpxParseError>).line, 7);
  }
});

test('throws with the correct line number for a missing time', () => {
  // Line 1: xml decl, line 2: <gpx>, line 3: <trk><trkseg>, line 4: good
  // point, line 5: the point missing <time>.
  const xml = gpxWrap(
    `<trk><trkseg>
<trkpt lat="0" lon="0"><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lat="1" lon="1"></trkpt>
</trkseg></trk>`,
  );

  try {
    parseGpx(xml);
    assert.fail('expected parseGpx to throw');
  } catch (error) {
    assert.ok(error instanceof GpxParseError);
    assert.equal((error as InstanceType<typeof GpxParseError>).line, 5);
  }
});

test('throws with the correct line number for an unparseable time', () => {
  // Line 1: xml decl, line 2: <gpx>, line 3: <trk><trkseg>, line 4: good
  // point, line 5: the point with an unparseable <time>.
  const xml = gpxWrap(
    `<trk><trkseg>
<trkpt lat="0" lon="0"><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lat="1" lon="1"><time>not-a-time</time></trkpt>
</trkseg></trk>`,
  );

  try {
    parseGpx(xml);
    assert.fail('expected parseGpx to throw');
  } catch (error) {
    assert.ok(error instanceof GpxParseError);
    assert.equal((error as InstanceType<typeof GpxParseError>).line, 5);
  }
});

test('a single-point track throws, naming the point line', () => {
  // Line 1: xml decl, line 2: <gpx>, line 3: <trk><trkseg>, line 4: the
  // single point.
  const xml = gpxWrap(
    `<trk><trkseg>
<trkpt lat="0" lon="0"><time>2026-01-01T00:00:00Z</time></trkpt>
</trkseg></trk>`,
  );

  try {
    parseGpx(xml);
    assert.fail('expected parseGpx to throw');
  } catch (error) {
    assert.ok(error instanceof GpxParseError);
    assert.equal((error as InstanceType<typeof GpxParseError>).line, 4);
  }
});

test('a track reduced to a single point by de-duplication throws', () => {
  const xml = gpxWrap(
    `<trk><trkseg>
<trkpt lat="0" lon="0"><time>2026-01-01T00:00:00Z</time></trkpt>
<trkpt lat="1" lon="1"><time>2026-01-01T00:00:00Z</time></trkpt>
</trkseg></trk>`,
  );

  assert.throws(() => parseGpx(xml), GpxParseError);
});
