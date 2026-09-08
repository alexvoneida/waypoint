#!/usr/bin/env node
// Regenerates the recorded Overpass responses scripts/test-osm-names.mjs
// reads as fixtures (fixtures/osm/, gitignored like the rest of fixtures/).
// This is the only place in the naming feature that touches the network --
// the test itself must stay fully offline. Run with:
//   node scripts/make-osm-fixtures.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GPX_DIR = join(REPO_ROOT, "fixtures/gpx");
const OUT_DIR = join(REPO_ROOT, "fixtures/osm");
mkdirSync(OUT_DIR, { recursive: true });

const { parseGpx } = await import(join(REPO_ROOT, "packages/correlation/src/gpx.ts"));

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const USER_AGENT = "waypoint-trail-naming/1.0 (+https://github.com/waypoint-app/waypoint)";
const PAD_METRES = 40;
const METRES_PER_DEGREE_LAT = 111_320;

function boundingBox(points) {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const midLat = (minLat + maxLat) / 2;
  const padLat = PAD_METRES / METRES_PER_DEGREE_LAT;
  const padLon = PAD_METRES / (METRES_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180));
  return {
    minLat: minLat - padLat,
    maxLat: maxLat + padLat,
    minLon: Math.min(...lons) - padLon,
    maxLon: Math.max(...lons) + padLon,
  };
}

async function fetchOverpass(bbox) {
  const query =
    `[out:json][timeout:40];` +
    `way[highway~"^(path|footway|track|bridleway)$"][name]` +
    `(${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon});` +
    `out geom;`;
  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(40_000),
  });
  if (!response.ok) {
    throw new Error(`Overpass HTTP ${response.status}`);
  }
  return response.json();
}

const CASES = [
  { gpx: "2026-08-22-morning-hike-hike.gpx", out: "blue-lakes.json" },
  { gpx: "2026-07-12-mount-harvard-hike.gpx", out: "mount-harvard.json" },
  { gpx: "2026-05-15-acatenango-hike-gap.gpx", out: "acatenango.json" },
];

for (const { gpx, out } of CASES) {
  const xml = readFileSync(join(GPX_DIR, gpx), "utf8");
  const track = parseGpx(xml);
  const bbox = boundingBox(track.points);
  console.log(`fetching ${out} for ${gpx} (${track.points.length} points)...`);
  const body = await fetchOverpass(bbox);
  writeFileSync(join(OUT_DIR, out), JSON.stringify(body, null, 2));
  console.log(`  wrote ${out}: ${body.elements?.length ?? 0} elements`);
  // Overpass's usage policy asks non-interactive clients to space requests out.
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
