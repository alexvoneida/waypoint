#!/usr/bin/env node
// Loads the labelled fixture set from fixtures/trail-pairs/ (built by
// scripts/make-trail-fixtures.mjs) and checks that scoreGeometryPair +
// classify agree with the expected label for every case. On any failure this
// prints every case's scores, not just the failing one, so a threshold
// change can be evaluated against the whole set at once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TRAIL_PAIRS_DIR = join(REPO_ROOT, "fixtures/trail-pairs");

const { parseGpx } = await import(join(REPO_ROOT, "packages/correlation/src/gpx.ts"));
const { scoreGeometryPair, classify } = await import(
  join(REPO_ROOT, "apps/web/src/lib/trails.ts")
);

function loadEnv() {
  const path = join(REPO_ROOT, ".env");
  const parsed = {};
  if (!existsSync(path)) return parsed;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return parsed;
}

const env = loadEnv();
const pool = new pg.Pool({
  connectionString:
    env.DATABASE_URL ?? "postgresql://waypoint_app:waypoint-app-dev-only@localhost:5432/waypoint",
  max: 4,
});

function trackToLineStringWkt(track) {
  const coordinates = track.points.map((point) => `${point.lon} ${point.lat}`).join(", ");
  return `LINESTRING(${coordinates})`;
}

function loadManifest() {
  const manifestPath = join(TRAIL_PAIRS_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${manifestPath} not found - run: node scripts/make-trail-fixtures.mjs`,
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

const manifest = loadManifest();
const results = [];

before(async () => {
  console.log(`fixture seed: ${manifest.seed}`);
});

after(async () => {
  printSummary();
  await pool.end();
});

function printSummary() {
  console.log("");
  console.log("case                 expected   fwd      rev      verdict");
  console.log("-------------------- ---------- -------- -------- ----------");
  for (const row of results) {
    console.log(
      `${row.id.padEnd(20)} ${row.expected.padEnd(10)} ${row.scoreFwd.toFixed(3).padEnd(8)} ${row.scoreRev
        .toFixed(3)
        .padEnd(8)} ${row.classification}${row.ok ? "" : "  <-- MISMATCH"}`,
    );
  }
}

for (const testCase of manifest.cases) {
  test(`trail match: ${testCase.id}`, async () => {
    const trackA = parseGpx(readFileSync(join(TRAIL_PAIRS_DIR, testCase.a), "utf8"));
    const trackB = parseGpx(readFileSync(join(TRAIL_PAIRS_DIR, testCase.b), "utf8"));
    const wktA = trackToLineStringWkt(trackA);
    const wktB = trackToLineStringWkt(trackB);

    const client = await pool.connect();
    let scoreFwd;
    let scoreRev;
    try {
      ({ scoreFwd, scoreRev } = await scoreGeometryPair(client, wktA, wktB));
    } finally {
      client.release();
    }
    const classification = classify(scoreFwd, scoreRev);
    const ok = classification === testCase.expected;
    results.push({ id: testCase.id, expected: testCase.expected, scoreFwd, scoreRev, classification, ok });

    assert.equal(
      classification,
      testCase.expected,
      `${testCase.id}: expected ${testCase.expected} but got ${classification} ` +
        `(scoreFwd=${scoreFwd.toFixed(3)}, scoreRev=${scoreRev.toFixed(3)}). ${testCase.note}\n` +
        formatAllScoresSoFar(),
    );
  });
}

// Called from a failing assertion so a single failure still surfaces every
// case scored up to that point, per the "print both scores for every case"
// requirement.
function formatAllScoresSoFar() {
  const lines = results.map(
    (row) =>
      `  ${row.id}: expected=${row.expected} fwd=${row.scoreFwd.toFixed(3)} rev=${row.scoreRev.toFixed(
        3,
      )} got=${row.classification}${row.ok ? "" : " MISMATCH"}`,
  );
  return `scores so far:\n${lines.join("\n")}`;
}
