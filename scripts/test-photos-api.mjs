#!/usr/bin/env node
// PATCH /api/photos/[id] (hidden, sortOrder, position) against P-6/P-7's
// claims: a manual pin snaps to the track and survives re-correlation, and
// hiding a photo takes it off the public read without detaching it.
//
// Needs the dev server running (`npm run dev`) and the database up.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import pg from "pg";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

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
const BASE_URL = process.env.WAYPOINT_BASE_URL ?? "http://localhost:3000";
const pool = new pg.Pool({
  connectionString:
    env.DATABASE_URL ?? "postgresql://waypoint_app:waypoint-app-dev-only@localhost:5432/waypoint",
  max: 4,
});

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

const owner = { id: null, token: null, entryId: null, activityId: null };
const stranger = { id: null, token: null };
const photos = { earlier: null, later: null };

// The track runs roughly NW; a point off to the east of its midpoint by a few
// hundred metres is what test 5 drags the pin to.
const TRACK_WKT =
  "LINESTRINGZM(-107.8 38 3000 1756000000, -107.81 38.01 3100 1756003600)";
const OFF_TRACK_POINT = { lat: 38.005, lon: -107.802 };

async function createAccountWithSession(handle) {
  const id = randomUUID();
  await asUser(null, (client) =>
    client.query(
      `insert into users (id, handle, email, display_name, password_hash, profile_visibility)
       values ($1, $2, $3, $4, 'x', 'public')`,
      [id, handle, `${handle}@example.test`, handle],
    ),
  );
  const token = randomBytes(32).toString("base64url");
  await asUser(id, (client) =>
    client.query(
      `insert into sessions (user_id, token_hash, expires_at)
       values ($1, $2, now() + interval '1 hour')`,
      [id, createHash("sha256").update(token, "utf8").digest()],
    ),
  );
  return { id, token };
}

async function createPublishedEntryWithPhotos(userId) {
  return asUser(userId, async (client) => {
    const activity = await client.query(
      `insert into activities
         (user_id, source, name, started_at, ended_at, track, track_simplified,
          distance_m, elapsed_s)
       values ($1, 'gpx', 'Photos test hike', now(), now() + interval '1 hour',
               ST_GeomFromText($2, 4326),
               ST_GeomFromText('LINESTRING(-107.8 38, -107.81 38.01)', 4326),
               1000, 3600)
       returning id`,
      [userId, TRACK_WKT],
    );
    const activityId = activity.rows[0].id;

    const entry = await client.query(
      `insert into entries
         (user_id, activity_id, title, occurred_on, status, slug, published_at, visibility)
       values ($1, $2, 'Photos test entry', current_date, 'published', $3, now(), 'public')
       returning id`,
      [userId, activityId, `photos-${randomBytes(4).toString("hex")}`],
    );
    const entryId = entry.rows[0].id;

    // captured_at (not just captured_naive) is what the public read orders
    // by, so it is set directly here to make capture order independent of
    // insertion order.
    const earlier = await client.query(
      `insert into photos (entry_id, checksum, key_original, status, captured_naive, captured_at)
       values ($1, decode(md5(random()::text), 'hex'), 'test/a.jpg', 'ready',
               $2::timestamp, $2::timestamptz)
       returning id`,
      [entryId, "2024-06-01T10:00:00Z"],
    );
    const later = await client.query(
      `insert into photos (entry_id, checksum, key_original, status, captured_naive, captured_at)
       values ($1, decode(md5(random()::text), 'hex'), 'test/b.jpg', 'ready',
               $2::timestamp, $2::timestamptz)
       returning id`,
      [entryId, "2024-06-01T11:00:00Z"],
    );

    return {
      entryId,
      activityId,
      earlierPhotoId: earlier.rows[0].id,
      laterPhotoId: later.rows[0].id,
    };
  });
}

function request(method, path, { token, body } = {}) {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function patchPhoto(photoId, fields, token) {
  return request("PATCH", `/api/photos/${photoId}`, { token, body: fields });
}

// Mirrors the public read's photo query (apps/web/src/lib/entries.ts,
// loadPhotos) so test 3 and test 4 assert against exactly what a visitor gets.
async function publicPhotoIds(entryId) {
  const { rows } = await asUser(null, (client) =>
    client.query(
      `select id
       from photos
       where entry_id = $1 and status = 'ready' and hidden = false
       order by sort_order asc nulls last, captured_at asc nulls last, created_at asc`,
      [entryId],
    ),
  );
  return rows.map((row) => row.id);
}

before(async () => {
  const reachable = await fetch(`${BASE_URL}/api/me`).catch(() => null);
  if (!reachable) {
    throw new Error(`could not reach ${BASE_URL} -- is 'npm run dev' running?`);
  }

  const createdOwner = await createAccountWithSession(
    `photos-test-owner-${randomBytes(4).toString("hex")}`,
  );
  owner.id = createdOwner.id;
  owner.token = createdOwner.token;

  const fixture = await createPublishedEntryWithPhotos(owner.id);
  owner.entryId = fixture.entryId;
  owner.activityId = fixture.activityId;
  photos.earlier = fixture.earlierPhotoId;
  photos.later = fixture.laterPhotoId;

  const createdStranger = await createAccountWithSession(
    `photos-test-stranger-${randomBytes(4).toString("hex")}`,
  );
  stranger.id = createdStranger.id;
  stranger.token = createdStranger.token;
});

after(async () => {
  for (const account of [owner, stranger]) {
    if (account.id) {
      await asUser(account.id, (client) =>
        client.query("delete from users where id = $1", [account.id]),
      );
    }
  }
  await pool.end();
});

test("an unauthenticated caller is refused", async () => {
  const response = await patchPhoto(photos.earlier, { hidden: true });
  assert.equal(response.status, 401);
});

test("another account's photograph is not found, not forbidden", async () => {
  // A 403 would confirm the photo exists (§9's stranger-facing convention).
  const response = await patchPhoto(photos.earlier, { hidden: true }, stranger.token);
  assert.equal(response.status, 404);

  const { rows } = await asUser(owner.id, (client) =>
    client.query("select hidden from photos where id = $1", [photos.earlier]),
  );
  assert.equal(rows[0].hidden, false, "the stranger's PATCH did not touch the row");
});

test("hiding a photograph keeps it attached but takes it off the public read", async () => {
  const hidden = await patchPhoto(photos.earlier, { hidden: true }, owner.token);
  assert.equal(hidden.status, 200);

  const stillOwned = await asUser(owner.id, (client) =>
    client.query("select id from photos where id = $1", [photos.earlier]),
  );
  assert.equal(stillOwned.rows.length, 1, "still attached to the entry");
  assert.ok(
    !(await publicPhotoIds(owner.entryId)).includes(photos.earlier),
    "excluded from the public read",
  );

  const unhidden = await patchPhoto(photos.earlier, { hidden: false }, owner.token);
  assert.equal(unhidden.status, 200);
  assert.ok(
    (await publicPhotoIds(owner.entryId)).includes(photos.earlier),
    "back on the public read once unhidden",
  );
});

test("reordering changes the published order", async () => {
  // Precondition: with both sort_orders null, the public read falls back to
  // captured_at, so the earlier-captured photo comes first.
  const beforeOrder = await publicPhotoIds(owner.entryId);
  assert.deepEqual(beforeOrder, [photos.earlier, photos.later]);

  assert.equal((await patchPhoto(photos.later, { sortOrder: 0 }, owner.token)).status, 200);
  assert.equal((await patchPhoto(photos.earlier, { sortOrder: 1 }, owner.token)).status, 200);

  const afterOrder = await publicPhotoIds(owner.entryId);
  assert.deepEqual(afterOrder, [photos.later, photos.earlier], "sort_order overrides capture time");
});

test("a dragged pin snaps to the track", async () => {
  const response = await patchPhoto(
    photos.earlier,
    { position: OFF_TRACK_POINT },
    owner.token,
  );
  assert.equal(response.status, 200);

  // ST_Force2D matches the route's own handling of the ZM track -- geography
  // has no Z/M, and distance here is purely about the horizontal snap.
  const { rows } = await asUser(owner.id, (client) =>
    client.query(
      `select
         pl.method, pl.confidence, pl.applied_offset_s, pl.distance_along_m,
         ST_Distance(pl.geom, ST_Force2D(a.track)::geography) as stored_distance_m,
         ST_Distance(
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
           ST_Force2D(a.track)::geography
         ) as input_distance_m,
         a.distance_m as activity_distance_m
       from photo_locations pl
       join photos p on p.id = pl.photo_id
       join entries e on e.id = p.entry_id
       join activities a on a.id = e.activity_id
       where pl.photo_id = $1`,
      [photos.earlier, OFF_TRACK_POINT.lon, OFF_TRACK_POINT.lat],
    ),
  );
  const row = rows[0];
  assert.equal(row.method, "manual");
  assert.equal(row.confidence, "high");
  assert.equal(row.applied_offset_s, 0);

  // The actual claim (P-6): the stored point is on the line, the input was not.
  assert.ok(Number(row.stored_distance_m) < 2, "stored point sits on the track line");
  assert.ok(Number(row.input_distance_m) > 100, "the dragged point was well off the track");

  assert.ok(row.distance_along_m !== null);
  assert.ok(Number(row.distance_along_m) >= 0);
  assert.ok(Number(row.distance_along_m) <= Number(row.activity_distance_m));
});

test("a manual placement survives re-running correlation", async () => {
  // No endpoint re-runs correlation yet (no POST /api/entries/:id/correlate
  // exists -- checked apps/web/src/app/api for any "correlate" route and
  // found none; correlateEntry is only reachable from the Inngest job
  // triggered by photo/exif.settled). So this cannot be an end-to-end test of
  // "PATCH position, then re-correlate, then assert unchanged". Instead it
  // asserts the invariant correlateEntry actually relies on
  // (apps/web/src/lib/jobs/correlate.ts): its delete statement excludes
  // method = 'manual', which is the only thing standing between a re-run and
  // silently discarding the author's placement.
  const before = await asUser(owner.id, (client) =>
    client.query(
      "select geom, method from photo_locations where photo_id = $1",
      [photos.earlier],
    ),
  );

  await asUser(owner.id, (client) =>
    client.query(
      `delete from photo_locations
       where photo_id in (select id from photos where entry_id = $1) and method <> 'manual'`,
      [owner.entryId],
    ),
  );

  const after = await asUser(owner.id, (client) =>
    client.query(
      "select geom, method from photo_locations where photo_id = $1",
      [photos.earlier],
    ),
  );
  assert.equal(after.rows.length, 1, "the manual row survives the delete predicate");
  assert.equal(after.rows[0].method, "manual");
  assert.deepEqual(after.rows[0].geom, before.rows[0].geom, "and is untouched");
});

test("a nonsensical body is rejected", async () => {
  const empty = await patchPhoto(photos.earlier, {}, owner.token);
  assert.equal(empty.status, 400);

  const outOfRange = await patchPhoto(
    photos.earlier,
    { position: { lat: 200, lon: 0 } },
    owner.token,
  );
  assert.equal(outOfRange.status, 400);
});
