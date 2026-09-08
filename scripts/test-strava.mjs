#!/usr/bin/env node
// Proves the Strava integration's pure pieces: token encryption at rest and
// the streams-to-Track conversion. Nothing here touches the network or the
// database, so it runs anywhere; the OAuth round trip and the backfill are
// walked by hand against the studio (see PHASE-5.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import { randomBytes } from "node:crypto";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_SRC = pathToFileURL(join(REPO_ROOT, "apps/web/src") + "/").href;

// Resolves "@/lib/..." the way apps/web's tsconfig path alias does, as
// scripts/test-trail-match.mjs does for the same reason.
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

// Set before the module is imported: the key is read on first use, then
// cached, so a test cannot swap it afterward.
const env = loadEnv();
process.env.STRAVA_TOKEN_ENCRYPTION_KEY =
  env.STRAVA_TOKEN_ENCRYPTION_KEY ?? randomBytes(32).toString("base64");

const { encryptToken, decryptToken, TokenEncryptionError } = await import(
  join(REPO_ROOT, "apps/web/src/lib/strava/crypto.ts")
);

test("a token round-trips through encryption unchanged", () => {
  const token = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
  assert.equal(decryptToken(encryptToken(token)), token);
});

test("ciphertext never contains the plaintext", () => {
  const token = "recognisable-token-value";
  const encrypted = encryptToken(token);
  assert.ok(!encrypted.toString("utf8").includes(token));
  assert.ok(!encrypted.toString("latin1").includes(token));
});

test("the same token encrypts differently every time", () => {
  // A fresh IV per call. Equal ciphertexts would tell an observer of the
  // table that two accounts hold the same token.
  const token = "same-token-twice";
  assert.notEqual(encryptToken(token).toString("hex"), encryptToken(token).toString("hex"));
});

test("a tampered ciphertext fails rather than decrypting to garbage", () => {
  const encrypted = encryptToken("token-to-tamper-with");
  encrypted[encrypted.length - 1] ^= 0xff;
  assert.throws(() => decryptToken(encrypted));
});

test("a tampered auth tag fails", () => {
  const encrypted = encryptToken("token-to-tamper-with");
  encrypted[14] ^= 0xff;
  assert.throws(() => decryptToken(encrypted));
});

test("an unknown format version is refused", () => {
  const encrypted = encryptToken("token");
  encrypted[0] = 99;
  assert.throws(() => decryptToken(encrypted), TokenEncryptionError);
});

test("a truncated value is refused rather than read out of bounds", () => {
  assert.throws(() => decryptToken(Buffer.alloc(4)), TokenEncryptionError);
});

const { streamsToTrack, toSport, StravaImportError } = await import(
  join(REPO_ROOT, "apps/web/src/lib/strava/import.ts")
);

// 2026-08-22T14:00:00Z, an activity that started at 08:00 local in Denver.
const START = new Date("2026-08-22T14:00:00.000Z");
const START_EPOCH = START.getTime() / 1000;

function summary(overrides = {}) {
  return {
    id: 15243891127,
    name: "Morning hike",
    sportType: "Hike",
    startDate: START,
    utcOffsetSeconds: -21600,
    timezone: "America/Denver",
    distanceM: 16200,
    ascentM: 620,
    movingS: 14400,
    elapsedS: 19800,
    ...overrides,
  };
}

test("streams become the same Track shape the GPX parser produces", () => {
  const track = streamsToTrack(summary(), {
    latlng: [
      [39.7, -105.2],
      [39.71, -105.21],
      [39.72, -105.22],
    ],
    time: [0, 60, 120],
    altitude: [1740, 1780, 1820],
  });

  assert.equal(track.points.length, 3);
  assert.deepEqual(track.points[0], { lat: 39.7, lon: -105.2, ele: 1740, time: START_EPOCH });
  // time is elapsed seconds from start_date, so the absolute instant is the
  // sum -- the property everything downstream depends on.
  assert.equal(track.points[2].time, START_EPOCH + 120);
  assert.equal(track.startedAt, START_EPOCH);
  assert.equal(track.endedAt, START_EPOCH + 120);
  assert.deepEqual(track.warnings, []);
});

test("a missing altitude stream leaves elevation null rather than zero", () => {
  // Zero would be a plausible-looking sea-level reading. The correlation
  // engine's own Track carries null for "no elevation recorded", and this
  // must not quietly become a number.
  const track = streamsToTrack(summary(), {
    latlng: [
      [39.7, -105.2],
      [39.71, -105.21],
    ],
    time: [0, 60],
    altitude: null,
  });
  assert.equal(track.points[0].ele, null);
  assert.equal(track.points[1].ele, null);
});

test("mismatched stream lengths truncate and warn rather than mispairing", () => {
  const track = streamsToTrack(summary(), {
    latlng: [
      [39.7, -105.2],
      [39.71, -105.21],
      [39.72, -105.22],
    ],
    time: [0, 60],
    altitude: null,
  });
  assert.equal(track.points.length, 2);
  assert.match(track.warnings.join(" "), /differed in length/);
});

test("a shorter altitude stream is ignored, not index-shifted", () => {
  const track = streamsToTrack(summary(), {
    latlng: [
      [39.7, -105.2],
      [39.71, -105.21],
      [39.72, -105.22],
    ],
    time: [0, 60, 120],
    altitude: [1740, 1780],
  });
  assert.deepEqual(
    track.points.map((point) => point.ele),
    [null, null, null],
  );
  assert.match(track.warnings.join(" "), /altitude stream was shorter/);
});

test("non-advancing timestamps are dropped, keeping time strictly ascending", () => {
  const track = streamsToTrack(summary(), {
    latlng: [
      [39.7, -105.2],
      [39.71, -105.21],
      [39.72, -105.22],
      [39.73, -105.23],
    ],
    time: [0, 60, 60, 120],
    altitude: null,
  });
  assert.equal(track.points.length, 3);
  for (let i = 1; i < track.points.length; i += 1) {
    assert.ok(track.points[i].time > track.points[i - 1].time);
  }
  assert.match(track.warnings.join(" "), /did not advance/);
});

test("a stream with fewer than two usable points is refused", () => {
  assert.throws(
    () => streamsToTrack(summary(), { latlng: [[39.7, -105.2]], time: [0], altitude: null }),
    StravaImportError,
  );
});

test("only travel on foot imports as a hike", () => {
  // Every tuned constant in the correlation engine assumes walking pace, so
  // a ride must not be filed as a hike (§1).
  assert.equal(toSport("Hike"), "hike");
  assert.equal(toSport("Walk"), "hike");
  assert.equal(toSport("Snowshoe"), "hike");
  assert.equal(toSport("Ride"), "other");
  assert.equal(toSport("VirtualRide"), "other");
  assert.equal(toSport("Kayaking"), "other");
});
