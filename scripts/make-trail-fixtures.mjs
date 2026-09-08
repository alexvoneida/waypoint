#!/usr/bin/env node
// Phase 4 fixture generator. Derives a labelled set of trail-matching test
// cases from the real tracks in fixtures/gpx/, into fixtures/trail-pairs/
// (gitignored, like the rest of fixtures/). Each case is a manifest entry
// plus two GPX files that scripts/test-trails.mjs parses and scores.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GPX_DIR = join(REPO_ROOT, "fixtures/gpx");
const OUT_DIR = join(REPO_ROOT, "fixtures/trail-pairs");

const { parseGpx } = await import(join(REPO_ROOT, "packages/correlation/src/gpx.ts"));

const SEED = 20260907;

// mulberry32: a five-line seeded PRNG, chosen for reproducibility rather than
// statistical quality -- the jitter case only needs a fixed, printable seed.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const METRES_PER_DEGREE_LAT = 111320;

function metresToDegLat(metres) {
  return metres / METRES_PER_DEGREE_LAT;
}

// Longitude degrees shrink toward the poles by cos(latitude); using the flat
// latitude conversion for both axes would understate east-west jitter away
// from the equator.
function metresToDegLon(metres, latDeg) {
  return metres / (METRES_PER_DEGREE_LAT * Math.cos((latDeg * Math.PI) / 180));
}

function haversineMetres(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function loadTrack(fileName) {
  const xml = readFileSync(join(GPX_DIR, fileName), "utf8");
  return parseGpx(xml);
}

function furthestPointIndex(points) {
  const start = points[0];
  let bestIndex = 0;
  let bestDistance = -1;
  points.forEach((point, i) => {
    const distance = haversineMetres(start, point);
    if (distance > bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  });
  return bestIndex;
}

function jitterPoints(points, rng, maxMetres) {
  return points.map((point) => {
    const angle = rng() * 2 * Math.PI;
    const distance = rng() * maxMetres;
    const dLat = metresToDegLat(distance * Math.sin(angle));
    const dLon = metresToDegLon(distance * Math.cos(angle), point.lat);
    return { ...point, lat: point.lat + dLat, lon: point.lon + dLon };
  });
}

// Reverses point order but keeps the original ascending timestamps, so the
// derived track still satisfies parseGpx's monotonic-time expectation.
function reverseWithAscendingTimes(points) {
  const times = points.map((point) => point.time);
  const reversedGeometry = [...points].reverse();
  return reversedGeometry.map((point, i) => ({ ...point, time: times[i] }));
}

function truncate(points, count) {
  return points.slice(0, Math.max(2, count));
}

function translate(points, dLatDeg, dLonDeg) {
  return points.map((point) => ({ ...point, lat: point.lat + dLatDeg, lon: point.lon + dLonDeg }));
}

function gpxDocument(points, name) {
  const trkpts = points
    .map((point) => {
      const eleTag = point.ele === null ? "" : `<ele>${point.ele}</ele>`;
      const timeIso = new Date(point.time * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      return `      <trkpt lat="${point.lat}" lon="${point.lon}">${eleTag}<time>${timeIso}</time></trkpt>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="waypoint make-trail-fixtures" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

function writeCase(id, pointsA, pointsB, expected, note) {
  const dir = join(OUT_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.gpx"), gpxDocument(pointsA, `${id}-a`));
  writeFileSync(join(dir, "b.gpx"), gpxDocument(pointsB, `${id}-b`));
  return { id, a: `${id}/a.gpx`, b: `${id}/b.gpx`, expected, note };
}

function main() {
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const rng = mulberry32(SEED);
  console.log(`seed: ${SEED}`);

  const cases = [];

  const harvard = loadTrack("2026-07-12-mount-harvard-hike.gpx");
  const acatenango = loadTrack("2026-05-15-acatenango-hike-gap.gpx");
  const eveningHike = loadTrack("2026-06-20-evening-hike-hike.gpx");
  const morningHike = loadTrack("2026-08-02-morning-hike-hike.gpx");

  cases.push(
    writeCase(
      "jitter",
      harvard.points,
      jitterPoints(harvard.points, rng, 15),
      "same",
      "Same track, every point perturbed by up to +-15m in a random direction.",
    ),
  );

  cases.push(
    writeCase(
      "reversed",
      harvard.points,
      reverseWithAscendingTimes(harvard.points),
      "same",
      "Same track walked in the opposite direction; buffer overlap is direction-agnostic.",
    ),
  );

  const turnIndex = furthestPointIndex(harvard.points);
  cases.push(
    writeCase(
      "out-and-back",
      truncate(harvard.points, turnIndex + 1),
      harvard.points,
      "same",
      "Real out-and-back truncated at its furthest point from the start, versus the full round trip.",
    ),
  );

  const prefixCount = Math.round(acatenango.points.length * 0.6);
  cases.push(
    writeCase(
      "prefix",
      truncate(acatenango.points, prefixCount),
      acatenango.points,
      // Not `same`, and this is the case the three-way classification exists
      // for. A strict prefix scores high one way and low the other by
      // construction - a 60% prefix cannot cover more than 60% of the longer
      // track - so bidirectional scoring refuses to merge a summit push into
      // the longer traverse it shares a start with, and asks instead. An
      // expected label of `same` here would only be reachable by widening the
      // threshold until the shared-trailhead case merged too.
      "suggested",
      "First 60% of a climb (the summit-push case) versus the full climb.",
    ),
  );

  const dLat = eveningHike.points[0].lat - morningHike.points[0].lat;
  const dLon = eveningHike.points[0].lon - morningHike.points[0].lon;
  cases.push(
    writeCase(
      "shared-trailhead",
      eveningHike.points,
      translate(morningHike.points, dLat, dLon),
      "different",
      "Two different real tracks translated to share a trailhead, then diverging.",
    ),
  );

  cases.push(
    writeCase(
      "distinct",
      eveningHike.points,
      morningHike.points,
      "different",
      "Two genuinely different real tracks, untouched.",
    ),
  );

  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify({ seed: SEED, cases }, null, 2));
  console.log(`wrote ${cases.length} cases to ${OUT_DIR}`);
}

main();
