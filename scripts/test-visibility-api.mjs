#!/usr/bin/env node
// Exercises the two visibility switches through the endpoints that own them,
// rather than through SQL. test-rls.mjs already proves the policies hold; what
// is unproven until here is that PATCH /api/settings/profile and
// PATCH /api/entries/:id actually move the switch the settings screen claims,
// and that the more-restrictive-of-the-two resolution (§9) is what a public
// reader ends up seeing.
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

const account = { id: null, handle: null, token: null, entryId: null, slug: null };
// A second account exists only to own a handle the first one will collide with.
const other = { id: null, handle: null };

// The session row is written directly rather than through sign-in: this test
// has no password to present, and getViewer accepts a bearer token by exactly
// the same path a cookie takes. What is under test is these endpoints, not the
// credential exchange.
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
  return { id, token, handle };
}

async function createPublishedEntry(userId) {
  return asUser(userId, async (client) => {
    const activity = await client.query(
      `insert into activities
         (user_id, source, name, started_at, ended_at, track, track_simplified,
          distance_m, elapsed_s)
       values ($1, 'gpx', 'Visibility test hike', now(), now() + interval '1 hour',
               ST_GeomFromText('LINESTRINGZM(-107.8 38 3000 1756000000, -107.81 38.01 3100 1756003600)', 4326),
               ST_GeomFromText('LINESTRING(-107.8 38, -107.81 38.01)', 4326),
               1000, 3600)
       returning id`,
      [userId],
    );
    const slug = `vis-${randomBytes(4).toString("hex")}`;
    const entry = await client.query(
      `insert into entries
         (user_id, activity_id, title, occurred_on, status, slug, published_at, visibility)
       values ($1, $2, 'Visibility test entry', current_date, 'published', $3, now(), 'public')
       returning id`,
      [userId, activity.rows[0].id, slug],
    );
    return { id: entry.rows[0].id, slug };
  });
}

/** What an anonymous reader can see, which is the only question §9 asks. */
async function publiclyVisible(entryId) {
  const { rows } = await asUser(null, (client) =>
    client.query("select 1 from visible_entries where id = $1", [entryId]),
  );
  return rows.length === 1;
}

function patch(path, body, token) {
  return fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  const reachable = await fetch(`${BASE_URL}/api/me`).catch(() => null);
  if (!reachable) {
    throw new Error(`could not reach ${BASE_URL} -- is 'npm run dev' running?`);
  }

  const created = await createAccountWithSession(`vis-test-${randomBytes(4).toString("hex")}`);
  account.id = created.id;
  account.token = created.token;
  account.handle = created.handle;

  const entry = await createPublishedEntry(account.id);
  account.entryId = entry.id;
  account.slug = entry.slug;

  const second = await createAccountWithSession(`vis-other-${randomBytes(4).toString("hex")}`);
  other.id = second.id;
  other.handle = second.handle;
});

after(async () => {
  // One delete each: users cascades to sessions, activities, entries and the rest.
  for (const owner of [account, other]) {
    if (owner.id) {
      await asUser(owner.id, (client) => client.query("delete from users where id = $1", [owner.id]));
    }
  }
  await pool.end();
});

test("an unauthenticated caller cannot change settings", async () => {
  const response = await patch("/api/settings/profile", { profileVisibility: "private" }, null);
  assert.equal(response.status, 401);
});

test("the account switch hides every entry and restores exactly what was public", async () => {
  assert.equal(await publiclyVisible(account.entryId), true, "precondition: the entry is public");

  const toPrivate = await patch(
    "/api/settings/profile",
    { profileVisibility: "private" },
    account.token,
  );
  assert.equal(toPrivate.status, 200);
  assert.equal(await publiclyVisible(account.entryId), false, "private account must hide the entry");

  const toPublic = await patch(
    "/api/settings/profile",
    { profileVisibility: "public" },
    account.token,
  );
  assert.equal(toPublic.status, 200);
  assert.equal(await publiclyVisible(account.entryId), true, "toggling back must restore it");
});

test("the entry switch is independent of the account switch", async () => {
  const toPrivate = await patch(
    `/api/entries/${account.entryId}`,
    { visibility: "private" },
    account.token,
  );
  assert.equal(toPrivate.status, 200);
  assert.equal(await publiclyVisible(account.entryId), false);

  // The account is still public here, which is the point: the entry's own
  // switch is doing the hiding, and the two resolve to the more restrictive.
  const { rows } = await asUser(account.id, (client) =>
    client.query("select profile_visibility from users where id = $1", [account.id]),
  );
  assert.equal(rows[0].profile_visibility, "public");

  const toPublic = await patch(
    `/api/entries/${account.entryId}`,
    { visibility: "public" },
    account.token,
  );
  assert.equal(toPublic.status, 200);
  assert.equal(await publiclyVisible(account.entryId), true);
});

test("another account's entry is not found, not forbidden", async () => {
  const stranger = await createAccountWithSession(`vis-stranger-${randomBytes(4).toString("hex")}`);
  try {
    const response = await patch(
      `/api/entries/${account.entryId}`,
      { visibility: "private" },
      stranger.token,
    );
    // §9: a 403 would confirm the entry exists.
    assert.equal(response.status, 404);
    assert.equal(await publiclyVisible(account.entryId), true, "and it must be unchanged");
  } finally {
    await asUser(stranger.id, (client) =>
      client.query("delete from users where id = $1", [stranger.id]),
    );
  }
});

test("a handle that would break routing is rejected", async () => {
  const response = await patch("/api/settings/profile", { handle: "not/a/handle" }, account.token);
  assert.equal(response.status, 400);
});

test("a taken handle is a conflict, not a crash", async () => {
  const response = await patch("/api/settings/profile", { handle: other.handle }, account.token);
  assert.equal(response.status, 409);
});

test("a lead photograph from another entry is rejected", async () => {
  const response = await patch(
    `/api/entries/${account.entryId}`,
    { leadPhotoId: randomUUID() },
    account.token,
  );
  assert.equal(response.status, 400);
});

// A-4. The track laid down in createPublishedEntry runs from (-107.8, 38) to
// (-107.81, 38.01) -- about 1.4 km. A 400 m radius on the first of those
// covers the start and leaves the far end alone, which is the shape a home
// trailhead has. A radius large enough to swallow the whole track would make
// every assertion below pass for the wrong reason.
const HOME = { lat: 38, lon: -107.8 };
const RADIUS_M = 400;

async function setPrivacyRadius(radiusM, center) {
  const response = await patch(
    "/api/settings/profile",
    { privacyRadiusM: radiusM, privacyCenter: center },
    account.token,
  );
  assert.equal(response.status, 200);
}

async function publicTrack(entryId) {
  const { rows } = await asUser(null, (client) =>
    client.query(
      `select st_geometrytype(a.track_simplified) as kind,
              st_length(a.track_simplified::geography) as length_m
       from visible_entries e
       join visible_activities a on a.id = e.activity_id
       where e.id = $1`,
      [entryId],
    ),
  );
  return rows[0] ?? null;
}

test("the privacy radius trims the published track and restores it at zero", async () => {
  const whole = await publicTrack(account.entryId);
  assert.equal(whole.kind, "ST_LineString");

  await setPrivacyRadius(RADIUS_M, HOME);
  const trimmed = await publicTrack(account.entryId);
  assert.ok(
    trimmed.length_m < whole.length_m,
    `the trimmed track must be shorter: ${trimmed.length_m} vs ${whole.length_m}`,
  );

  // Not merely shorter -- the trimmed stretch must be the one near home.
  const { rows } = await asUser(null, (client) =>
    client.query(
      `select st_distance(a.track_simplified::geography,
                          ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography) as gap_m
       from visible_entries e
       join visible_activities a on a.id = e.activity_id
       where e.id = $1`,
      [account.entryId, HOME.lon, HOME.lat],
    ),
  );
  assert.ok(
    rows[0].gap_m >= RADIUS_M * 0.95,
    `published geometry must stay clear of home: ${rows[0].gap_m} m`,
  );

  await setPrivacyRadius(0, null);
  const restored = await publicTrack(account.entryId);
  assert.equal(restored.length_m.toFixed(3), whole.length_m.toFixed(3));
});

test("the owner's own read of the same activity is never trimmed", async () => {
  await setPrivacyRadius(RADIUS_M, HOME);
  try {
    const { rows } = await asUser(account.id, (client) =>
      client.query(
        `select st_length(a.track_simplified::geography) as length_m
         from entries e join activities a on a.id = e.activity_id
         where e.id = $1`,
        [account.entryId],
      ),
    );
    const publicLength = (await publicTrack(account.entryId)).length_m;
    assert.ok(
      rows[0].length_m > publicLength,
      "the radius hides a home from readers, not from the person who set it",
    );
  } finally {
    await setPrivacyRadius(0, null);
  }
});

test("a photograph inside the radius is excluded from public reads", async () => {
  const photoId = await asUser(account.id, async (client) => {
    const photo = await client.query(
      `insert into photos (entry_id, checksum, key_original, status)
       values ($1, decode(md5(random()::text), 'hex'), 'test/original.jpg', 'ready')
       returning id`,
      [account.entryId],
    );
    await client.query(
      `insert into photo_locations
         (photo_id, geom, method, confidence, applied_offset_s)
       values ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 'interpolated', 'high', 0)`,
      [photo.rows[0].id, HOME.lon, HOME.lat],
    );
    return photo.rows[0].id;
  });

  const visibleToPublic = async () => {
    const { rows } = await asUser(null, (client) =>
      client.query("select 1 from photos where id = $1", [photoId]),
    );
    return rows.length === 1;
  };

  assert.equal(await visibleToPublic(), true, "precondition: no radius set");

  await setPrivacyRadius(RADIUS_M, HOME);
  // §9 excludes the photograph itself, not only its pin: a frame that still
  // appears while its neighbours plot on the map is its own kind of tell.
  assert.equal(await visibleToPublic(), false);

  await setPrivacyRadius(0, null);
  assert.equal(await visibleToPublic(), true, "and it comes back when the radius is cleared");
});

test("an uncorrelated photograph survives a radius being set", async () => {
  const photoId = await asUser(account.id, async (client) => {
    const photo = await client.query(
      `insert into photos (entry_id, checksum, key_original, status)
       values ($1, decode(md5(random()::text), 'hex'), 'test/unplaced.jpg', 'ready')
       returning id`,
      [account.entryId],
    );
    return photo.rows[0].id;
  });

  await setPrivacyRadius(RADIUS_M, HOME);
  try {
    const { rows } = await asUser(null, (client) =>
      client.query("select 1 from photos where id = $1", [photoId]),
    );
    // within_privacy_radius returns false, never null, for a photo with no
    // location -- a null here would propagate through the policy's NOT and
    // make every unplaced photograph vanish.
    assert.equal(rows.length, 1, "a photo with no location is not inside the radius");
  } finally {
    await setPrivacyRadius(0, null);
  }
});
