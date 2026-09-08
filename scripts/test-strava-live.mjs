#!/usr/bin/env node
// Drives the Strava listing and import against the real API and the real
// database, in the style of scripts/test-trail-match.mjs: a throwaway user,
// every query through an asUser transaction as the application role, and
// full cleanup afterward.
//
// Needs STRAVA_DEV_REFRESH_TOKEN in .env (a personal credential, local
// development only -- see .env.example). Skips rather than fails without it,
// so this stays runnable on a machine with no Strava access.
//
// This does NOT cover the OAuth round trip: authorize, consent and callback
// need a browser and are walked by hand against the studio. What it covers is
// everything after a connection exists, which is the half that can break
// silently.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import pg from "pg";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_SRC = pathToFileURL(join(REPO_ROOT, "apps/web/src") + "/").href;

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

const env = loadEnv();
for (const key of [
  "STRAVA_CLIENT_ID",
  "STRAVA_CLIENT_SECRET",
  "STRAVA_TOKEN_ENCRYPTION_KEY",
  "DATABASE_URL",
  "DATABASE_ADMIN_URL",
]) {
  if (env[key]) process.env[key] = env[key];
}

const REFRESH_TOKEN = env.STRAVA_DEV_REFRESH_TOKEN;
if (!REFRESH_TOKEN) {
  console.log("SKIP no STRAVA_DEV_REFRESH_TOKEN in .env - the live import test needs one");
  process.exit(0);
}

const { refreshTokens } = await import(join(REPO_ROOT, "apps/web/src/lib/strava/api.ts"));
const { encryptToken } = await import(join(REPO_ROOT, "apps/web/src/lib/strava/crypto.ts"));
const { fetchAndStorePage } = await import(
  join(REPO_ROOT, "apps/web/src/lib/jobs/strava-backfill.ts")
);
const { importOne } = await import(join(REPO_ROOT, "apps/web/src/lib/jobs/strava-import.ts"));
const { loadListingPage, loadListingFacets } = await import(
  join(REPO_ROOT, "apps/web/src/lib/strava/listing.ts")
);
const { loadTrackPoints } = await import(join(REPO_ROOT, "apps/web/src/lib/track.ts"));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
// Cleanup runs outside any user's transaction, so it needs the owning role
// (which bypasses its own RLS) exactly as test-trail-match.mjs does.
const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 });

async function asUser(userId, run) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config($1, $2, true)", ["app.user_id", userId ?? ""]);
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

let userId;
let importedStravaId = null;

before(async () => {
  const handle = `stravatest${Date.now()}`;
  const { rows } = await adminPool.query(
    `insert into users (handle, email, display_name, password_hash)
     values ($1, $2, 'Strava Live Test', 'x') returning id`,
    [handle, `${handle}@example.invalid`],
  );
  userId = rows[0].id;

  const tokens = await refreshTokens(REFRESH_TOKEN);
  await asUser(userId, (client) =>
    client.query(
      `insert into strava_connections
         (user_id, athlete_id, access_token_encrypted, refresh_token_encrypted,
          expires_at, scopes, backfill_status)
       values ($1, $2, $3, $4, $5, 'read,activity:read_all', 'none')`,
      [
        userId,
        tokens.athleteId || 0,
        encryptToken(tokens.accessToken),
        encryptToken(tokens.refreshToken),
        tokens.expiresAt,
      ],
    ),
  );
});

after(async () => {
  if (userId) {
    // users cascades to strava_connections, strava_activities, activities and
    // entries, so one delete is the whole teardown.
    await adminPool.query("delete from users where id = $1", [userId]);
  }
  await pool.end();
  await adminPool.end();
});

test("one real page of activities lands in the listing cache", async () => {
  const outcome = await fetchAndStorePage(userId, null);
  assert.equal(outcome.rateLimited, false, "rate limited - rerun in fifteen minutes");
  assert.ok(outcome.count > 0, "the athlete has no activities to list");

  const page = await asUser(userId, (client) =>
    loadListingPage(client, userId, { limit: 5, offset: 0 }),
  );
  assert.equal(page.total, outcome.count);
  const row = page.activities[0];
  assert.ok(row.name.length > 0);
  assert.ok(row.distanceM >= 0);
  // Newest first, which is what makes the oldest start_date a valid cursor.
  for (let i = 1; i < page.activities.length; i += 1) {
    assert.ok(page.activities[i - 1].startDate >= page.activities[i].startDate);
  }
});

test("the cursor advances to the oldest activity on the page", async () => {
  const { rows } = await asUser(userId, (client) =>
    client.query("select backfill_cursor from strava_connections where user_id = $1", [userId]),
  );
  const cursor = rows[0].backfill_cursor;
  assert.ok(cursor instanceof Date);

  const page = await asUser(userId, (client) =>
    loadListingPage(client, userId, { limit: 1000, offset: 0 }),
  );
  const oldest = page.activities.at(-1).startDate;
  assert.equal(cursor.toISOString(), new Date(oldest).toISOString());
});

test("facets come from what the account actually has", async () => {
  const facets = await asUser(userId, (client) => loadListingFacets(client, userId));
  assert.ok(facets.sportTypes.length > 0);
  assert.ok(facets.years.length > 0);
  assert.deepEqual(facets.years, [...facets.years].sort((a, b) => b - a));
});

test("an activity imports to a draft entry with a real track", async () => {
  const page = await asUser(userId, (client) =>
    loadListingPage(client, userId, { limit: 100, offset: 0, onlyUnimported: true }),
  );
  // Anything with a distance has a position stream; a manually-entered
  // activity has none, and that is the one case import legitimately refuses.
  const candidate = page.activities.find((row) => row.distanceM > 0);
  assert.ok(candidate, "no activity with a distance to import");
  importedStravaId = candidate.stravaId;

  const result = await importOne(userId, candidate.stravaId);
  assert.equal(result.imported, true);

  const { rows } = await asUser(userId, (client) =>
    client.query(
      `select a.source, a.external_id, a.ascent_m, a.moving_s, a.elapsed_s,
              a.distance_m, a.local_zone, a.sport,
              e.status, e.slug, e.occurred_on
       from activities a
       join entries e on e.activity_id = a.id
       where a.id = $1`,
      [result.activityId],
    ),
  );
  const row = rows[0];
  assert.equal(row.source, "strava");
  assert.equal(row.external_id, candidate.stravaId);
  assert.equal(row.status, "draft");
  assert.equal(row.slug, null, "a draft must have no slug - that is what makes it unaddressable");
  // All four statistics are Strava's own, stored verbatim (§5). Distance is
  // the one that would look plausible if it were wrong: summing a 1 Hz track
  // point to point comes out about 13.5% long, and nothing on the page would
  // give that away.
  assert.equal(row.ascent_m, candidate.ascentM);
  assert.equal(row.moving_s, candidate.movingS);
  assert.equal(row.distance_m, candidate.distanceM);
  assert.equal(row.elapsed_s, candidate.elapsedS);

  // The geometry is still checked against that distance, loosely: a track
  // built with swapped coordinates, or from the wrong activity, would be off
  // by orders of magnitude rather than by jitter.
  const { rows: geometry } = await asUser(userId, (client) =>
    client.query("select ST_Length(track::geography) as measured from activities where id = $1", [
      result.activityId,
    ]),
  );
  const ratio = geometry[0].measured / candidate.distanceM;
  assert.ok(ratio > 0.8 && ratio < 1.25, `track geometry measures ${ratio.toFixed(2)}x Strava's distance`);

  // occurred_on is the activity's local date, not the UTC one.
  const localDate = new Date(candidate.startDate).toLocaleDateString("en-CA", {
    timeZone: candidate.timezone ?? "UTC",
  });
  assert.equal(row.occurred_on.toISOString().slice(0, 10), localDate);
});

test("the imported track reads back as ascending TrackPoints", async () => {
  const { rows } = await asUser(userId, (client) =>
    client.query("select id from activities where user_id = $1 and source = 'strava'", [userId]),
  );
  const points = await asUser(userId, (client) => loadTrackPoints(client, rows[0].id));
  assert.ok(points.length > 1);
  for (let i = 1; i < points.length; i += 1) {
    assert.ok(points[i].time > points[i - 1].time, "track times must strictly ascend");
  }
  assert.ok(Math.abs(points[0].lat) <= 90 && Math.abs(points[0].lon) <= 180);
});

test("re-importing the same activity is a no-op, not a duplicate", async () => {
  const result = await importOne(userId, importedStravaId);
  assert.equal(result.imported, false);
  assert.equal(result.reason, "already-imported");

  const { rows } = await asUser(userId, (client) =>
    client.query(
      "select count(*)::int as n from activities where user_id = $1 and external_id = $2",
      [userId, importedStravaId],
    ),
  );
  assert.equal(rows[0].n, 1);
});

test("a re-scan does not forget what was already imported", async () => {
  // The upsert refreshes name and distance but must leave activity_id alone;
  // losing it would offer an imported activity for import all over again.
  await fetchAndStorePage(userId, null);
  const page = await asUser(userId, (client) =>
    loadListingPage(client, userId, { limit: 1000, offset: 0 }),
  );
  const row = page.activities.find((entry) => entry.stravaId === importedStravaId);
  assert.ok(row.activityId, "the imported activity lost its link on re-listing");
});
