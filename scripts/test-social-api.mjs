#!/usr/bin/env node
// Likes and comments (S-2, S-3, S-4) through their endpoints.
//
// The interesting assertions are the ones about who may act rather than the
// ones about the happy path: §9 says a social interaction is possible exactly
// where the entry is visible, resolved through the same view readers use. That
// is a claim about what a stranger and a signed-out visitor get, so those are
// the cases this covers.
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

const author = { id: null, token: null, entryId: null };
const reader = { id: null, token: null };

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

async function createPublishedEntry(userId) {
  return asUser(userId, async (client) => {
    const activity = await client.query(
      `insert into activities
         (user_id, source, name, started_at, ended_at, track, track_simplified,
          distance_m, elapsed_s)
       values ($1, 'gpx', 'Social test hike', now(), now() + interval '1 hour',
               ST_GeomFromText('LINESTRINGZM(-107.8 38 3000 1756000000, -107.81 38.01 3100 1756003600)', 4326),
               ST_GeomFromText('LINESTRING(-107.8 38, -107.81 38.01)', 4326),
               1000, 3600)
       returning id`,
      [userId],
    );
    const entry = await client.query(
      `insert into entries
         (user_id, activity_id, title, occurred_on, status, slug, published_at, visibility)
       values ($1, $2, 'Social test entry', current_date, 'published', $3, now(), 'public')
       returning id`,
      [userId, activity.rows[0].id, `social-${randomBytes(4).toString("hex")}`],
    );
    return entry.rows[0].id;
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

async function social(token) {
  const response = await request("GET", `/api/entries/${author.entryId}/social`, { token });
  assert.equal(response.status, 200);
  return response.json();
}

function patchEntry(fields) {
  return request("PATCH", `/api/entries/${author.entryId}`, { token: author.token, body: fields });
}

before(async () => {
  const reachable = await fetch(`${BASE_URL}/api/me`).catch(() => null);
  if (!reachable) {
    throw new Error(`could not reach ${BASE_URL} -- is 'npm run dev' running?`);
  }

  const createdAuthor = await createAccountWithSession(
    `social-author-${randomBytes(4).toString("hex")}`,
  );
  author.id = createdAuthor.id;
  author.token = createdAuthor.token;
  author.entryId = await createPublishedEntry(author.id);

  const createdReader = await createAccountWithSession(
    `social-reader-${randomBytes(4).toString("hex")}`,
  );
  reader.id = createdReader.id;
  reader.token = createdReader.token;
});

after(async () => {
  for (const account of [author, reader]) {
    if (account.id) {
      await asUser(account.id, (client) =>
        client.query("delete from users where id = $1", [account.id]),
      );
    }
  }
  await pool.end();
});

test("a signed-out visitor reads the counts but cannot act", async () => {
  const payload = await social(null);
  assert.equal(payload.likeCount, 0);
  assert.equal(payload.viewerLiked, false);
  assert.equal(payload.canInteract, false, "no session means no like button and no composer");

  const like = await request("PUT", `/api/entries/${author.entryId}/like`);
  assert.equal(like.status, 401);
});

test("liking is idempotent and unliking removes it cleanly", async () => {
  const first = await request("PUT", `/api/entries/${author.entryId}/like`, { token: reader.token });
  assert.equal(first.status, 200);
  // The second like is absorbed by the primary key rather than counted, which
  // is the whole of S-2's idempotency requirement.
  const second = await request("PUT", `/api/entries/${author.entryId}/like`, {
    token: reader.token,
  });
  assert.equal(second.status, 200);

  const afterLike = await social(reader.token);
  assert.equal(afterLike.likeCount, 1);
  assert.equal(afterLike.viewerLiked, true);

  // The count is visible to anyone who can see the entry, not only the liker.
  assert.equal((await social(null)).likeCount, 1);

  const removed = await request("DELETE", `/api/entries/${author.entryId}/like`, {
    token: reader.token,
  });
  assert.equal(removed.status, 200);
  const afterUnlike = await social(reader.token);
  assert.equal(afterUnlike.likeCount, 0);
  assert.equal(afterUnlike.viewerLiked, false);
});

test("a comment is attributed and visible to everyone who can see the entry", async () => {
  const posted = await request("POST", `/api/entries/${author.entryId}/comments`, {
    token: reader.token,
    body: { body: "Beautiful light on the ridge." },
  });
  assert.equal(posted.status, 201);

  const anonymous = await social(null);
  assert.equal(anonymous.comments.length, 1);
  assert.equal(anonymous.comments[0].body, "Beautiful light on the ridge.");
  // §9: a comment on a public entry is public writing under your handle.
  assert.ok(anonymous.comments[0].authorHandle.startsWith("social-reader-"));
  assert.equal(anonymous.comments[0].canDelete, false, "a visitor deletes nothing");
});

test("the entry's author may delete a comment they did not write", async () => {
  const asAuthor = await social(author.token);
  const comment = asAuthor.comments[0];
  assert.equal(comment.canDelete, true, "S-3 lets the entry author remove any comment on it");

  const deleted = await request("DELETE", `/api/comments/${comment.id}`, { token: author.token });
  assert.equal(deleted.status, 200);
  assert.equal((await social(null)).comments.length, 0);

  // Soft, so a thread does not develop holes: the row is still there.
  const { rows } = await asUser(author.id, (client) =>
    client.query("select deleted_at, deleted_by from comments where id = $1", [comment.id]),
  );
  assert.ok(rows[0].deleted_at, "deletion is soft");
  assert.equal(rows[0].deleted_by, author.id, "and records who did it");
});

test("a stranger cannot delete someone else's comment, and gets a 404 rather than a 403", async () => {
  const posted = await request("POST", `/api/entries/${author.entryId}/comments`, {
    token: author.token,
    body: { body: "Thanks for coming along." },
  });
  const { id } = await posted.json();

  const refused = await request("DELETE", `/api/comments/${id}`, { token: reader.token });
  // A 403 would confirm the comment exists (§9).
  assert.equal(refused.status, 404);
  assert.equal((await social(null)).comments.length, 1, "and it is still there");
});

test("closing comments hides the composer and refuses new ones", async () => {
  assert.equal((await patchEntry({ commentsOpen: false })).status, 200);

  const payload = await social(reader.token);
  assert.equal(payload.commentsOpen, false);

  const refused = await request("POST", `/api/entries/${author.entryId}/comments`, {
    token: reader.token,
    body: { body: "One more thought." },
  });
  // The comments_insert policy is what refuses this, not a check in the route
  // -- S-4 costs one flag precisely because the resolution already exists.
  assert.equal(refused.status, 403);
});

test("a private entry answers nothing to a stranger", async () => {
  assert.equal((await patchEntry({ visibility: "private" })).status, 200);

  const anonymous = await request("GET", `/api/entries/${author.entryId}/social`);
  assert.equal(anonymous.status, 404);

  const stranger = await request("GET", `/api/entries/${author.entryId}/social`, {
    token: reader.token,
  });
  assert.equal(stranger.status, 404, "a signed-in stranger is still a stranger");

  // The owner still reads their own, which is what taking a viewer id rather
  // than branching on owner-or-anonymous buys.
  const owner = await request("GET", `/api/entries/${author.entryId}/social`, {
    token: author.token,
  });
  assert.equal(owner.status, 200);
});
