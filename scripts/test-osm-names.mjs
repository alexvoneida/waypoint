#!/usr/bin/env node
// Fully offline: reads recorded Overpass responses from fixtures/osm/ (built
// by node scripts/make-osm-fixtures.mjs, gitignored like the rest of
// fixtures/) and stubs global fetch to serve them, so this suite never
// touches the network -- Overpass is a shared third-party service and this
// project must not hit it from every test run or from CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_SRC = pathToFileURL(join(REPO_ROOT, "apps/web/src") + "/").href;
const GPX_DIR = join(REPO_ROOT, "fixtures/gpx");
const OSM_DIR = join(REPO_ROOT, "fixtures/osm");

// Same "@/" resolver as scripts/test-trail-match.mjs -- osm-names.ts imports
// TRAIL_BUFFER_METRES/SUGGEST_THRESHOLD from "@/lib/trails".
const loaderSource = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  let target;
  if (specifier.startsWith("@/")) {
    target = new URL(specifier.slice(2), "${WEB_SRC}").href;
  } else if (context.parentURL && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    target = new URL(specifier, context.parentURL).href;
  } else {
    return nextResolve(specifier, context);
  }
  if (!/\\.[a-zA-Z0-9]+$/.test(target)) {
    for (const ext of [".ts", ".mts", ".js"]) {
      try {
        if (existsSync(fileURLToPath(target + ext))) {
          return nextResolve(target + ext, context);
        }
      } catch {}
    }
  }
  return nextResolve(target, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);

const { parseGpx } = await import(join(REPO_ROOT, "packages/correlation/src/gpx.ts"));
const { scoreNameCandidates, suggestTrailName, MIN_COVERAGE_FOR_ACCEPTANCE, MIN_SCORE_FOR_ACCEPTANCE } =
  await import(join(REPO_ROOT, "apps/web/src/lib/osm-names.ts"));

function loadTrackPoints(gpxFileName) {
  const xml = readFileSync(join(GPX_DIR, gpxFileName), "utf8");
  return parseGpx(xml).points;
}

function loadOverpassFixture(name) {
  const path = join(OSM_DIR, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`${path} not found - run: node scripts/make-osm-fixtures.mjs`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function waysFromFixture(overpassBody) {
  return (overpassBody.elements ?? [])
    .filter((el) => el.type === "way" && el.tags?.name && el.geometry?.length > 0)
    .map((el) => ({ name: el.tags.name, nodes: el.geometry }));
}

// suggestTrailName's only network dependency is one fetch() call. Stubbing
// it for the duration of `run` is the entire seam needed to exercise the
// full orchestration (bbox padding, response parsing, thresholding) without
// reaching the real Overpass API.
async function withStubbedOverpass(overpassBody, run) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => overpassBody });
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("Blue Lakes: a decisive geometric winner is picked, and the low-coverage runner-up never wins", async () => {
  const trackPoints = loadTrackPoints("2026-08-22-morning-hike-hike.gpx");
  const overpassBody = loadOverpassFixture("blue-lakes");

  const result = await withStubbedOverpass(overpassBody, () =>
    suggestTrailName(trackPoints, "Morning Hike"),
  );

  assert.ok(result, "expected an accepted candidate");
  assert.equal(result.name, "Blue Lakes Trail #201");
  assert.ok(result.confidence > 0.85, `expected a decisive score, got ${result.confidence}`);

  const dallas = result.candidates.find((c) => c.name === "Dallas Trail #200");
  assert.ok(dallas, "expected Dallas Trail #200 to appear as a scored runner-up");
  assert.ok(
    dallas.coverage < MIN_COVERAGE_FOR_ACCEPTANCE,
    `expected Dallas Trail #200's real ~1.4% coverage, got ${dallas.coverage}`,
  );
  assert.ok(
    dallas.score < MIN_SCORE_FOR_ACCEPTANCE,
    `a low-coverage runner-up must never clear the acceptance threshold, got ${dallas.score}`,
  );
});

test("Mount Harvard: the activity name breaks a real geometric near-tie, and would not without it", () => {
  const trackPoints = loadTrackPoints("2026-07-12-mount-harvard-hike.gpx");
  const ways = waysFromFixture(loadOverpassFixture("mount-harvard"));

  const withoutBoost = scoreNameCandidates(trackPoints, ways, "");
  const winnerNoBoost = withoutBoost.find((c) => c.name === "Mount Harvard/Horn Fork Trail");
  const runnerNoBoost = withoutBoost.find((c) => c.name === "Horn Fork Basin Trail");
  assert.ok(winnerNoBoost && runnerNoBoost, "expected both candidates to be scored");
  // Proves the near-tie is real geometry, not a contrived fixture: on raw
  // coverage alone the two are within a couple of points of each other.
  assert.ok(
    Math.abs(winnerNoBoost.coverage - runnerNoBoost.coverage) < 0.05,
    `expected a near-tie on raw coverage, got ${winnerNoBoost.coverage} vs ${runnerNoBoost.coverage}`,
  );

  const withBoost = scoreNameCandidates(trackPoints, ways, "Mount Harvard");
  const winner = withBoost[0];
  const runnerUp = withBoost.find((c) => c.name === "Horn Fork Basin Trail");
  assert.equal(winner.name, "Mount Harvard/Horn Fork Trail");
  // Proves the boost is what does the work: the same pair, now decisively
  // separated once the activity's own name is applied.
  assert.ok(
    winner.score - runnerUp.score > 0.1,
    `expected a decisive margin once boosted, got ${winner.score} vs ${runnerUp.score}`,
  );
});

test("a generic activity name ('Morning Hike') contributes no text boost", () => {
  const trackPoints = loadTrackPoints("2026-08-22-morning-hike-hike.gpx");
  const ways = waysFromFixture(loadOverpassFixture("blue-lakes"));

  const candidates = scoreNameCandidates(trackPoints, ways, "Morning Hike");
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    assert.equal(candidate.textBoost, 0, `expected zero boost for ${candidate.name}`);
  }
});

test("a track with no named ways returns null rather than a bad guess", async () => {
  const trackPoints = loadTrackPoints("2026-05-15-acatenango-hike-gap.gpx");
  const overpassBody = loadOverpassFixture("acatenango");
  assert.equal((overpassBody.elements ?? []).length, 0, "fixture is expected to have zero named ways");

  const result = await withStubbedOverpass(overpassBody, () =>
    suggestTrailName(trackPoints, "Acatenango Hike"),
  );

  assert.equal(result, null);
});

test("a 1.4%-coverage candidate never wins", () => {
  const trackPoints = loadTrackPoints("2026-08-22-morning-hike-hike.gpx");
  const ways = waysFromFixture(loadOverpassFixture("blue-lakes"));

  const candidates = scoreNameCandidates(trackPoints, ways, "Morning Hike");
  const winner = candidates[0];
  const dallas = candidates.find((c) => c.name === "Dallas Trail #200");

  assert.ok(dallas.coverage < MIN_COVERAGE_FOR_ACCEPTANCE, `expected low coverage, got ${dallas.coverage}`);
  assert.notEqual(winner.name, "Dallas Trail #200");
});
