#!/usr/bin/env node
// Phase 3 gate: proves the ingest-to-publish write path end to end against a
// running dev stack -- sign in (or create) a development account, upload a
// GPX track through POST /api/activities, upload its photographs through the
// real presigned-URL path, create the entry, run EXIF extraction, derivative
// generation and correlation to completion, then publish and print the
// public URL.
//
//   node scripts/seed-entry.mjs [gpxFilename] [photoFilenamesCsv]
//
// Defaults to the 2026-08-22 hike and its two photographs.
//
// The three background jobs are invoked directly from their exported
// functions rather than through a live Inngest Dev Server: POST /api/entries
// already sends the real "photo/uploaded" events (proving that wiring runs),
// but nothing consumes them without a separate `inngest-cli dev` process,
// which this script's required setup (db + objects + `next dev`, per the
// phase's own verification instructions) does not include. Calling the same
// functions the Inngest handlers call keeps this script self-contained while
// still exercising the real production code path -- the same choice
// scripts/test-pipeline.mjs makes for storage and image derivation.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import pg from "pg";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_SRC = pathToFileURL(join(REPO_ROOT, "apps/web/src") + "/").href;

// Resolves "@/lib/..." the way apps/web's tsconfig path alias does, and fills
// in the ".ts" extension on same-package relative imports (e.g. "./client")
// that Next's bundler resolver accepts but plain Node ESM does not. Scoped to
// "@/" and relative specifiers only, so it never touches how bare package
// specifiers (sharp, pg, inngest, @waypoint/correlation, ...) resolve.
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
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

const BASE_URL = process.env.WAYPOINT_BASE_URL ?? "http://localhost:3000";

let passed = true;
function pass(label, detail = "") {
  console.log(`PASS ${label}${detail ? " - " + detail : ""}`);
}
function fail(label, detail = "") {
  console.log(`FAIL ${label}${detail ? " - " + detail : ""}`);
  passed = false;
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  let body = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body };
}

function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

// A fixed dev identity, reused across runs rather than minted fresh each
// time -- "create (or reuse)", per the script's own brief. Reuse means a
// second run against the same database exercises the "publish twice" and
// "re-upload the same photos" paths for free instead of only ever the
// first-run path.
const DEV_HANDLE = "waypointseed";
const DEV_EMAIL = "waypoint-seed@example.test";
const DEV_PASSWORD = "waypoint-seed-dev-password";

async function ensureDevAccount() {
  const signIn = await api("/api/auth/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD }),
  });
  if (signIn.response.ok) {
    pass("dev account", `reused existing account (${DEV_EMAIL})`);
    return signIn.body.token;
  }

  const issued = await api("/api/invites/dev-issue", { method: "POST" });
  if (!issued.response.ok) {
    throw new Error(`could not mint a dev invite: ${issued.response.status} ${JSON.stringify(issued.body)}`);
  }

  const redeemed = await api("/api/invites/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: issued.body.code,
      handle: DEV_HANDLE,
      email: DEV_EMAIL,
      displayName: "Waypoint Seed",
      password: DEV_PASSWORD,
    }),
  });
  if (!redeemed.response.ok) {
    throw new Error(`could not redeem dev invite: ${redeemed.response.status} ${JSON.stringify(redeemed.body)}`);
  }
  pass("dev account", `created new account (${DEV_EMAIL})`);
  return redeemed.body.token;
}

// Neither the session token nor anything /api/me returns carries the user's
// id (auth.ts deliberately keeps a session token identity-free), so this is
// the one place the script reaches past the HTTP API, exactly as
// /api/invites/dev-issue itself reaches for DATABASE_ADMIN_URL to perform an
// operator action no ordinary request can.
async function lookupUserId(handle) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
  try {
    const { rows } = await pool.query("select id from users where handle = $1", [handle]);
    const id = rows[0]?.id;
    if (!id) throw new Error(`no user found for handle ${handle}`);
    return id;
  } finally {
    await pool.end();
  }
}

async function uploadActivity(token, gpxFilename) {
  const gpxPath = join(REPO_ROOT, "fixtures/gpx", gpxFilename);
  if (!existsSync(gpxPath)) {
    throw new Error(`GPX fixture not found: ${gpxPath}`);
  }
  const xml = readFileSync(gpxPath, "utf8");
  const { response, body } = await api("/api/activities", {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/gpx+xml" }),
    body: xml,
  });
  if (!response.ok) {
    throw new Error(`POST /api/activities failed: ${response.status} ${JSON.stringify(body)}`);
  }
  pass(
    "GPX uploaded",
    `"${body.name}", ${body.pointCount} points, ${body.distanceM.toFixed(0)} m, ${body.elapsedSeconds} s elapsed`,
  );
  if (body.warnings.length > 0) {
    console.log(`     parser warnings: ${body.warnings.join("; ")}`);
  }
  return body;
}

async function signAndUploadPhotos(token, photoFilenames) {
  const files = photoFilenames.map((filename) => {
    const filePath = join(REPO_ROOT, "fixtures/photos", filename);
    if (!existsSync(filePath)) {
      throw new Error(`photo fixture not found: ${filePath}`);
    }
    return { filename, bytes: readFileSync(filePath) };
  });

  const { response, body } = await api("/api/uploads/sign", {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify(
      files.map((file) => ({
        filename: file.filename,
        contentType: "image/jpeg",
        contentLength: file.bytes.length,
      })),
    ),
  });
  if (!response.ok) {
    throw new Error(`POST /api/uploads/sign failed: ${response.status} ${JSON.stringify(body)}`);
  }
  pass("presigned upload URLs issued", `${body.files.length} file(s)`);

  const byFilename = new Map(files.map((file) => [file.filename, file]));
  const uploaded = [];
  for (const signed of body.files) {
    const file = byFilename.get(signed.filename);
    const putResponse = await fetch(signed.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg", "Content-Length": String(file.bytes.length) },
      body: file.bytes,
    });
    if (!putResponse.ok) {
      throw new Error(`presigned PUT failed for ${signed.filename}: ${putResponse.status}`);
    }
    uploaded.push({ filename: signed.filename, photoId: signed.photoId, key: signed.key });
  }
  pass("photographs uploaded via presigned PUT", uploaded.map((u) => u.filename).join(", "));
  return uploaded;
}

async function createEntry(token, activityId, title, uploaded) {
  const { response, body } = await api("/api/entries", {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      activityId,
      title,
      photoKeys: uploaded.map((u) => u.key),
    }),
  });
  if (!response.ok) {
    throw new Error(`POST /api/entries failed: ${response.status} ${JSON.stringify(body)}`);
  }
  pass("entry created", `id ${body.id}, ${body.photoIds.length} photo(s)`);
  return body;
}

async function runPipeline(photoIds, userId) {
  const { extractExifForPhoto, deriveForPhoto } = await import("@/lib/jobs/photo");

  let extracted = 0;
  let derived = 0;
  let failed = 0;
  for (const photoId of photoIds) {
    const exifOutcome = await extractExifForPhoto(photoId, userId);
    if (exifOutcome.status === "failed") {
      failed += 1;
      continue;
    }
    extracted += 1;
    const deriveOutcome = await deriveForPhoto(photoId, userId);
    if (deriveOutcome.status === "ready") derived += 1;
  }

  if (failed > 0) {
    fail("EXIF extraction", `${failed} of ${photoIds.length} photo(s) failed -- see photos.exif.error`);
  } else {
    pass("EXIF extraction", `${extracted} of ${photoIds.length} photo(s)`);
  }
  pass("derivatives generated", `${derived} of ${photoIds.length} photo(s)`);
}

async function runCorrelation(entryId, userId) {
  const { correlateEntry } = await import("@/lib/jobs/correlate");
  const result = await correlateEntry(entryId, userId);
  pass("correlation ran", `${result.placed} placed, ${result.unplaced} unplaced`);
  return result;
}

async function reportPlacements(entryId) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
  try {
    const { rows } = await pool.query(
      `select
         p.id as photo_id,
         pl.applied_offset_s,
         pl.confidence,
         pl.method,
         pl.gap_seconds,
         ST_Distance(pl.geom, a.track::geography) as distance_to_track_m
       from photos p
       join photo_locations pl on pl.photo_id = p.id
       join entries e on e.id = p.entry_id
       join activities a on a.id = e.activity_id
       where p.entry_id = $1
       order by pl.distance_along_m`,
      [entryId],
    );
    if (rows.length === 0) {
      fail("placements recorded", "no photo_locations rows for this entry");
      return;
    }
    const offsets = new Set(rows.map((row) => row.applied_offset_s));
    pass(
      "inferred offset",
      `${[...offsets].join(", ")} second(s) (${[...offsets].map((s) => (s / 3600).toFixed(2)).join(", ")} h)`,
    );
    for (const row of rows) {
      console.log(
        `     photo ${row.photo_id}: confidence ${row.confidence}, method ${row.method}, ` +
          `gap ${row.gap_seconds ?? "n/a"} s, distance to track ${Number(row.distance_to_track_m).toFixed(2)} m`,
      );
    }
    const worstDistance = Math.max(...rows.map((row) => Number(row.distance_to_track_m)));
    if (worstDistance < 20) {
      pass("placed coordinates lie on the track", `worst case ${worstDistance.toFixed(2)} m`);
    } else {
      fail("placed coordinates lie on the track", `worst case ${worstDistance.toFixed(2)} m (expected single digits)`);
    }
  } finally {
    await pool.end();
  }
}

async function publishEntry(token, entryId) {
  const { response, body } = await api(`/api/entries/${entryId}/publish`, {
    method: "POST",
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`POST /api/entries/${entryId}/publish failed: ${response.status} ${JSON.stringify(body)}`);
  }
  pass("entry published", `slug "${body.slug}"`);
  return body;
}

async function main() {
  const gpxFilename = process.argv[2] ?? "2026-08-22-morning-hike-hike.gpx";
  const photoFilenames = (process.argv[3] ?? "DSCF0591.jpg,DSCF0593.jpg")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  const health = await fetch(`${BASE_URL}/api/waitlist`, { method: "GET" }).catch(() => null);
  if (!health) {
    fail("dev server reachable", `could not reach ${BASE_URL} -- is 'npx next dev' running?`);
    printSummary();
    process.exit(1);
  }

  const token = await ensureDevAccount();
  const userId = await lookupUserId(DEV_HANDLE);

  const activity = await uploadActivity(token, gpxFilename);
  const uploaded = await signAndUploadPhotos(token, photoFilenames);
  const entry = await createEntry(token, activity.id, `Seeded: ${activity.name}`, uploaded);

  await runPipeline(entry.photoIds, userId);
  await runCorrelation(entry.id, userId);
  await reportPlacements(entry.id);

  const published = await publishEntry(token, entry.id);
  // Publishing must be idempotent -- run it again and confirm the slug held.
  const republished = await publishEntry(token, entry.id);
  if (republished.slug === published.slug) {
    pass("publish is idempotent", `slug unchanged across two calls ("${published.slug}")`);
  } else {
    fail("publish is idempotent", `slug changed from "${published.slug}" to "${republished.slug}"`);
  }

  console.log("");
  console.log(`public URL: ${BASE_URL}${published.url}`);

  printSummary();
  process.exit(passed ? 0 : 1);
}

function printSummary() {
  console.log("");
  console.log(passed ? "PASS: Phase 3 gate met." : "FAIL: Phase 3 gate not met.");
}

main().catch((error) => {
  fail("unhandled error", error.stack ?? String(error));
  printSummary();
  process.exit(1);
});
