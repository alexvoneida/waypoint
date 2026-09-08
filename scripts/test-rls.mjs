#!/usr/bin/env node
// Proves cross-account isolation against a real database rather than asserting
// it from the policy text. Everything here connects as waypoint_app, the role
// the application uses, because a test run as the table owner would pass with
// every policy removed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function loadEnv() {
  const path = join(REPO_ROOT, '.env');
  const parsed = {};
  if (!existsSync(path)) return parsed;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return parsed;
}

const env = loadEnv();
const pool = new pg.Pool({
  connectionString:
    env.DATABASE_URL ?? 'postgresql://waypoint_app:waypoint-app-dev-only@localhost:5432/waypoint',
  max: 4,
});

/** Runs a callback in one transaction with app.user_id set, exactly as a
 *  request does. `set_config(..., true)` is transaction-local, so the setting
 *  cannot survive into the next borrower of a pooled connection. */
async function asUser(userId, run) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1, $2, true)', ['app.user_id', userId ?? '']);
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

const alice = { id: null };
const bob = { id: null };
let aliceDraftId = null;
let alicePublishedId = null;
let aliceDraft = null;
let alicePublished = null;

// The id is generated here rather than by the database, because account
// creation has no acting user and `insert ... returning id` needs a SELECT
// policy on the new row to return it. Weakening users_select_self to allow that
// would make every account readable; generating the id costs nothing.
async function createUser(handle) {
  const id = randomUUID();
  await asUser(null, (client) =>
    client.query(
      `insert into users (id, handle, email, display_name, password_hash, profile_visibility)
       values ($1, $2, $3, $4, 'x', 'public')`,
      [id, handle, `${handle}@example.test`, handle],
    ),
  );
  return id;
}

async function createEntry(userId, { published }) {
  return asUser(userId, async (client) => {
    const activity = await client.query(
      `insert into activities
         (user_id, source, name, started_at, ended_at, track, track_simplified,
          distance_m, elapsed_s)
       values ($1, 'gpx', 'Test hike', now(), now() + interval '1 hour',
               ST_GeomFromText('LINESTRINGZM(-107.8 38 3000 1756000000, -107.81 38.01 3100 1756003600)', 4326),
               ST_GeomFromText('LINESTRING(-107.8 38, -107.81 38.01)', 4326),
               1000, 3600)
       returning id`,
      [userId],
    );
    const entry = await client.query(
      `insert into entries (user_id, activity_id, title, occurred_on, status, slug, published_at)
       values ($1, $2, 'Test entry', current_date, $3, $4, $5) returning id`,
      [
        userId,
        activity.rows[0].id,
        published ? 'published' : 'draft',
        published ? `test-${Math.random().toString(36).slice(2, 10)}` : null,
        published ? new Date() : null,
      ],
    );
    const entryId = entry.rows[0].id;
    const photo = await client.query(
      `insert into photos (entry_id, checksum, key_original, key_thumb, status)
       values ($1, $2, 'originals/test.jpg', 'derived/test-thumb.webp', 'ready')
       returning id`,
      [entryId, Buffer.from(randomUUID())],
    );
    await client.query(
      `insert into photo_locations
         (photo_id, geom, method, confidence, applied_offset_s)
       values ($1, ST_GeogFromText('POINT(-107.8 38)'), 'interpolated', 'high', -21600)`,
      [photo.rows[0].id],
    );
    return { entryId, activityId: activity.rows[0].id, photoId: photo.rows[0].id };
  });
}

before(async () => {
  alice.id = await createUser(`alice${Date.now()}`);
  bob.id = await createUser(`bob${Date.now()}`);
  aliceDraft = await createEntry(alice.id, { published: false });
  alicePublished = await createEntry(alice.id, { published: true });
  aliceDraftId = aliceDraft.entryId;
  alicePublishedId = alicePublished.entryId;
});

after(async () => {
  await pool.end();
});

test('the application role cannot bypass policies', async () => {
  const { rows } = await pool.query(
    `select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
  );
  assert.equal(rows[0].rolsuper, false, 'the app role must not be a superuser');
  assert.equal(rows[0].rolbypassrls, false, 'the app role must not have BYPASSRLS');
});

test('a second account cannot read the first account\'s drafts', async () => {
  const { rows } = await asUser(bob.id, (client) =>
    client.query('select id from entries where id = $1', [aliceDraftId]),
  );
  assert.equal(rows.length, 0);
});

test('a second account cannot read the first account\'s published entries from the base table', async () => {
  const { rows } = await asUser(bob.id, (client) =>
    client.query('select id from entries where id = $1', [alicePublishedId]),
  );
  assert.equal(rows.length, 0, 'the base table is owner-only; public reads go through the view');
});

test('a second account cannot modify or delete the first account\'s entries', async () => {
  const updated = await asUser(bob.id, (client) =>
    client.query(`update entries set title = 'stolen' where id = $1`, [aliceDraftId]),
  );
  assert.equal(updated.rowCount, 0);

  const deleted = await asUser(bob.id, (client) =>
    client.query('delete from entries where id = $1', [aliceDraftId]),
  );
  assert.equal(deleted.rowCount, 0);

  const stillThere = await asUser(alice.id, (client) =>
    client.query('select title from entries where id = $1', [aliceDraftId]),
  );
  assert.equal(stillThere.rows[0].title, 'Test entry');
});

test('an unauthenticated reader sees no entries at all', async () => {
  const { rows } = await asUser(null, (client) => client.query('select id from entries'));
  assert.equal(rows.length, 0);
});

test('a draft never appears in the public view', async () => {
  const { rows } = await asUser(null, (client) =>
    client.query('select id from visible_entries where id = $1', [aliceDraftId]),
  );
  assert.equal(rows.length, 0);
});

test('a published entry of a public account appears in the public view', async () => {
  const { rows } = await asUser(null, (client) =>
    client.query('select id from visible_entries where id = $1', [alicePublishedId]),
  );
  assert.equal(rows.length, 1);
});

test('making the account private hides its published entries immediately', async () => {
  await asUser(alice.id, (client) =>
    client.query(`update users set profile_visibility = 'private' where id = $1`, [alice.id]),
  );
  const hidden = await asUser(null, (client) =>
    client.query('select id from visible_entries where id = $1', [alicePublishedId]),
  );
  assert.equal(hidden.rows.length, 0, 'the account switch alone must hide the entry');

  await asUser(alice.id, (client) =>
    client.query(`update users set profile_visibility = 'public' where id = $1`, [alice.id]),
  );
});

test('making one entry private hides only that entry', async () => {
  await asUser(alice.id, (client) =>
    client.query(`update entries set visibility = 'private' where id = $1`, [alicePublishedId]),
  );
  const hidden = await asUser(null, (client) =>
    client.query('select id from visible_entries where id = $1', [alicePublishedId]),
  );
  assert.equal(hidden.rows.length, 0);

  await asUser(alice.id, (client) =>
    client.query(`update entries set visibility = 'public' where id = $1`, [alicePublishedId]),
  );
});

test('a private account keeps a public profile header', async () => {
  await asUser(alice.id, (client) =>
    client.query(`update users set profile_visibility = 'private' where id = $1`, [alice.id]),
  );
  const { rows } = await asUser(null, (client) =>
    client.query('select handle, display_name from public_profiles where id = $1', [alice.id]),
  );
  assert.equal(rows.length, 1, 'the header stays findable so a stranger can request to follow');
  await asUser(alice.id, (client) =>
    client.query(`update users set profile_visibility = 'public' where id = $1`, [alice.id]),
  );
});

test('the public profile view exposes no email or password hash', async () => {
  const { rows } = await pool.query(
    `select column_name from information_schema.columns
     where table_name = 'public_profiles'`,
  );
  const columns = rows.map((row) => row.column_name);
  assert.ok(!columns.includes('email'));
  assert.ok(!columns.includes('password_hash'));
});

test('a second account cannot read the first account\'s sessions or connections', async () => {
  await asUser(alice.id, (client) =>
    client.query(
      `insert into sessions (user_id, token_hash, expires_at)
       values ($1, $2, now() + interval '1 day')`,
      [alice.id, Buffer.from(`session-${Date.now()}`)],
    ),
  );
  const { rows } = await asUser(bob.id, (client) =>
    client.query('select id from sessions where user_id = $1', [alice.id]),
  );
  assert.equal(rows.length, 0);
});

test('a visitor cannot enumerate invite codes or the waitlist', async () => {
  const invites = await asUser(null, (client) => client.query('select code from invites'));
  assert.equal(invites.rows.length, 0);
  const waitlist = await asUser(null, (client) =>
    client.query('select email from waitlist_signups'),
  );
  assert.equal(waitlist.rows.length, 0);
});

test('app.user_id does not leak to the next user of a pooled connection', async () => {
  await asUser(alice.id, (client) => client.query('select 1'));
  const { rows } = await pool.query(`select current_app_user() is null as unset`);
  assert.equal(rows[0].unset, true);
});


// 0008 added permissive read policies for the rows a public entry page needs.
// They are resolved through visible_entries, so the question these tests answer
// is whether that resolution actually holds for a draft and for a private
// account, rather than only for the happy path the page exercises.

test('a visitor can read the photos and activity of a published public entry', async () => {
  const photos = await asUser(null, (client) =>
    client.query('select id from photos where entry_id = $1', [alicePublishedId]),
  );
  assert.equal(photos.rows.length, 1);

  // 0012 took the permissive policy off activities and put public reads
  // through visible_activities instead. The reason is that a row policy
  // selects rows and cannot rewrite a column, so a readable base row is an
  // unclipped track by construction -- the privacy radius could not be
  // enforced while this table answered a visitor directly.
  const baseActivity = await asUser(null, (client) =>
    client.query('select id from activities where id = $1', [alicePublished.activityId]),
  );
  assert.equal(baseActivity.rows.length, 0, 'the base table is owner-only, like entries');

  const activity = await asUser(null, (client) =>
    client.query('select id from visible_activities where id = $1', [alicePublished.activityId]),
  );
  assert.equal(activity.rows.length, 1);

  const locations = await asUser(null, (client) =>
    client.query('select photo_id from photo_locations where photo_id = $1', [
      alicePublished.photoId,
    ]),
  );
  assert.equal(locations.rows.length, 1);
});

test('a visitor cannot read the photos, activity or locations of a draft', async () => {
  const photos = await asUser(null, (client) =>
    client.query('select id from photos where entry_id = $1', [aliceDraftId]),
  );
  assert.equal(photos.rows.length, 0, 'a draft photo must not be readable');

  const activity = await asUser(null, (client) =>
    client.query('select id from activities where id = $1', [aliceDraft.activityId]),
  );
  assert.equal(activity.rows.length, 0, 'a draft activity must not be readable');

  const locations = await asUser(null, (client) =>
    client.query('select photo_id from photo_locations where photo_id = $1', [aliceDraft.photoId]),
  );
  assert.equal(locations.rows.length, 0, 'a draft photo location must not be readable');
});

test('a second account cannot read another account\'s draft photos', async () => {
  const { rows } = await asUser(bob.id, (client) =>
    client.query('select id from photos where entry_id = $1', [aliceDraftId]),
  );
  assert.equal(rows.length, 0);
});

test('making the account private hides its photos, not only its entry row', async () => {
  await asUser(alice.id, (client) =>
    client.query(`update users set profile_visibility = 'private' where id = $1`, [alice.id]),
  );

  const photos = await asUser(null, (client) =>
    client.query('select id from photos where entry_id = $1', [alicePublishedId]),
  );
  const locations = await asUser(null, (client) =>
    client.query('select photo_id from photo_locations where photo_id = $1', [
      alicePublished.photoId,
    ]),
  );

  await asUser(alice.id, (client) =>
    client.query(`update users set profile_visibility = 'public' where id = $1`, [alice.id]),
  );

  assert.equal(photos.rows.length, 0, 'the photographs must follow the account switch');
  assert.equal(locations.rows.length, 0, 'the coordinates must follow it too');
});

test('the owner still reads their own draft photos', async () => {
  const { rows } = await asUser(alice.id, (client) =>
    client.query('select id from photos where entry_id = $1', [aliceDraftId]),
  );
  assert.equal(rows.length, 1);
});
