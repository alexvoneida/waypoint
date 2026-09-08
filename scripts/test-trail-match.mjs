#!/usr/bin/env node
// Proves apps/web/src/lib/trail-match.ts against a real database, in the
// style of scripts/test-rls.mjs: connects as waypoint_app (the application
// role, so trails' new RLS policies are actually exercised) and runs every
// query inside asUser, the same withUser-shaped helper. Creates its own
// throwaway user, activities and entries and cleans them all up afterward.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_SRC = pathToFileURL(join(REPO_ROOT, "apps/web/src") + "/").href;
const GPX_DIR = join(REPO_ROOT, "fixtures/gpx");
const TRAIL_PAIRS_DIR = join(REPO_ROOT, "fixtures/trail-pairs");

// Resolves "@/lib/..." the way apps/web's tsconfig path alias does, exactly
// as scripts/seed-entry.mjs's loader does -- trail-match.ts imports from
// "@/lib/trails", which plain Node ESM cannot resolve on its own.
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
const { insertActivity } = await import(join(REPO_ROOT, "apps/web/src/lib/track.ts"));
const { matchActivityToTrail, recountTrailEntries } = await import(
  join(REPO_ROOT, "apps/web/src/lib/trail-match.ts")
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
// Cleanup only. trails deliberately has no delete policy at all (0009's own
// point), and the owner-scoped delete policies on entries/activities/
// trail_links only pass for the owning user's own transaction -- so teardown
// after a test, which has no such transaction, needs the table owner's
// connection (which always bypasses its own RLS) rather than waypoint_app's.
const adminPool = new pg.Pool({
  connectionString: env.DATABASE_ADMIN_URL ?? "postgresql://waypoint:waypoint@localhost:5432/waypoint",
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

function loadTrack(relativePath) {
  const xml = readFileSync(join(REPO_ROOT, relativePath), "utf8");
  return parseGpx(xml);
}

async function createActivity(userId, name, track) {
  return asUser(userId, (client) => insertActivity(client, userId, { name, source: "gpx", track }));
}

async function createEntry(userId, activityId, title) {
  return asUser(userId, async (client) => {
    const { rows } = await client.query(
      `insert into entries (user_id, activity_id, title, occurred_on, status, slug)
       values ($1, $2, $3, current_date, 'draft', null)
       returning id`,
      [userId, activityId, title],
    );
    return rows[0].id;
  });
}

// Read as the owning user, not anonymously: trail_links and entries have no
// public select policy (0003_rls.sql's owner-only policies, unrelated to
// 0009), so a plain pool.query here would silently see zero rows under RLS
// rather than the rows the test just wrote.
async function trailLinksFor(userId, activityId) {
  return asUser(userId, async (client) => {
    const { rows } = await client.query(
      "select trail_id, status, score_fwd, score_rev from trail_links where activity_id = $1",
      [activityId],
    );
    return rows;
  });
}

async function entryTrailId(userId, entryId) {
  return asUser(userId, async (client) => {
    const { rows } = await client.query("select trail_id from entries where id = $1", [entryId]);
    return rows[0]?.trail_id ?? null;
  });
}

async function canonicalGeomEquals(userId, trailId, activityId) {
  return asUser(userId, async (client) => {
    const { rows } = await client.query(
      `select ST_Equals(t.canonical_geom, a.track_simplified) as equals
       from trails t, activities a
       where t.id = $1 and a.id = $2`,
      [trailId, activityId],
    );
    return rows[0]?.equals ?? false;
  });
}

const user = { id: null };

before(async () => {
  user.id = await createUser(`trailmatch${Date.now()}`);
});

after(async () => {
  if (user.id) {
    await adminPool.query("delete from users where id = $1", [user.id]);
  }
  await pool.end();
  await adminPool.end();
});

// Deletes exactly the rows one test created, in dependency order, right after
// that test finishes -- rather than batching cleanup into the top-level
// after(). findCandidateTrails narrows against the whole trails table, so a
// trail left over from an earlier test would be a real (and wrong) candidate
// for a later test's activities: two of this suite's own fixtures overlap
// real trailheads (fixtures/trail-pairs/jitter/a.gpx is byte-for-byte the
// same track as fixtures/gpx/2026-07-12-mount-harvard-hike.gpx), so this
// bleed-through is not hypothetical.
async function withCleanup(fn) {
  const resources = { activityIds: [], entryIds: [], trailIds: new Set() };
  try {
    await fn(resources);
  } finally {
    if (resources.entryIds.length > 0) {
      await adminPool.query("delete from entries where id = any($1)", [resources.entryIds]);
    }
    if (resources.activityIds.length > 0) {
      await adminPool.query("delete from trail_links where activity_id = any($1)", [
        resources.activityIds,
      ]);
      await adminPool.query("delete from activities where id = any($1)", [resources.activityIds]);
    }
    if (resources.trailIds.size > 0) {
      await adminPool.query("delete from trails where id = any($1)", [[...resources.trailIds]]);
    }
  }
}

test("two activities on the same route link to one trail automatically", async () => {
  await withCleanup(async (resources) => {
    const trackA = loadTrack("fixtures/trail-pairs/jitter/a.gpx");
    const trackB = loadTrack("fixtures/trail-pairs/jitter/b.gpx");

    const activityAId = await createActivity(user.id, "Same route A", trackA);
    const activityBId = await createActivity(user.id, "Same route B", trackB);
    resources.activityIds.push(activityAId, activityBId);

    const outcomeA = await asUser(user.id, (client) => matchActivityToTrail(client, activityAId));
    resources.trailIds.add(outcomeA.trailId);
    assert.equal(outcomeA.classification, "founded");

    const outcomeB = await asUser(user.id, (client) => matchActivityToTrail(client, activityBId));
    resources.trailIds.add(outcomeB.trailId);
    assert.equal(outcomeB.classification, "auto");
    assert.equal(outcomeB.trailId, outcomeA.trailId, "both activities must land on the same trail");

    const linksA = await trailLinksFor(user.id, activityAId);
    const linksB = await trailLinksFor(user.id, activityBId);
    assert.equal(linksA.length, 1);
    assert.equal(linksA[0].status, "auto");
    assert.equal(linksB.length, 1);
    assert.equal(linksB[0].status, "auto");
  });
});

test("two activities from different trailheads found two trails", async () => {
  await withCleanup(async (resources) => {
    const trackA = loadTrack("fixtures/gpx/2026-07-12-mount-harvard-hike.gpx");
    const trackB = loadTrack("fixtures/gpx/2026-06-20-evening-hike-hike.gpx");

    const activityAId = await createActivity(user.id, "Trailhead A", trackA);
    const activityBId = await createActivity(user.id, "Trailhead B", trackB);
    resources.activityIds.push(activityAId, activityBId);

    const outcomeA = await asUser(user.id, (client) => matchActivityToTrail(client, activityAId));
    resources.trailIds.add(outcomeA.trailId);
    const outcomeB = await asUser(user.id, (client) => matchActivityToTrail(client, activityBId));
    resources.trailIds.add(outcomeB.trailId);

    assert.equal(outcomeA.classification, "founded");
    assert.equal(outcomeB.classification, "founded");
    assert.notEqual(
      outcomeA.trailId,
      outcomeB.trailId,
      "genuinely different tracks must not share a trail",
    );
  });
});

test("a suggested-scoring pair records a suggested link and does not apply it to entries.trail_id", async () => {
  await withCleanup(async (resources) => {
    const fullTrack = loadTrack("fixtures/trail-pairs/prefix/b.gpx");
    const prefixTrack = loadTrack("fixtures/trail-pairs/prefix/a.gpx");

    const fullActivityId = await createActivity(user.id, "Full climb", fullTrack);
    const prefixActivityId = await createActivity(user.id, "Summit push", prefixTrack);
    resources.activityIds.push(fullActivityId, prefixActivityId);

    const fullOutcome = await asUser(user.id, (client) => matchActivityToTrail(client, fullActivityId));
    resources.trailIds.add(fullOutcome.trailId);
    assert.equal(fullOutcome.classification, "founded");

    // The entry is created before matching runs, matching production order for
    // an activity that already has a trail candidate by the time its entry
    // exists -- otherwise there would be no entries row for the suggested path
    // to (not) touch.
    const prefixEntryId = await createEntry(user.id, prefixActivityId, "Summit push entry");
    resources.entryIds.push(prefixEntryId);

    const prefixOutcome = await asUser(user.id, (client) =>
      matchActivityToTrail(client, prefixActivityId),
    );
    resources.trailIds.add(prefixOutcome.trailId);

    const links = await trailLinksFor(user.id, prefixActivityId);
    const suggestedLink = links.find((link) => link.trail_id === fullOutcome.trailId);
    assert.ok(suggestedLink, "expected a trail_links row against the full climb's trail");
    assert.equal(suggestedLink.status, "suggested");

    const trailId = await entryTrailId(user.id, prefixEntryId);
    assert.notEqual(
      trailId,
      fullOutcome.trailId,
      "a suggested link must never be the trail entries.trail_id is set to",
    );
    // No `same` candidate existed for the prefix activity, so it founds its
    // own trail per step 6 -- that is what entries.trail_id ends up pointing
    // at, never the merely-suggested one.
    assert.equal(trailId, prefixOutcome.trailId);
  });
});

test("re-running matchActivityToTrail for the same activity is idempotent", async () => {
  await withCleanup(async (resources) => {
    const track = loadTrack("fixtures/gpx/2026-08-02-morning-hike-hike.gpx");
    const activityId = await createActivity(user.id, "Idempotency check", track);
    resources.activityIds.push(activityId);

    const first = await asUser(user.id, (client) => matchActivityToTrail(client, activityId));
    resources.trailIds.add(first.trailId);
    const second = await asUser(user.id, (client) => matchActivityToTrail(client, activityId));
    const third = await asUser(user.id, (client) => matchActivityToTrail(client, activityId));

    assert.equal(second.trailId, first.trailId);
    assert.equal(third.trailId, first.trailId);

    const links = await trailLinksFor(user.id, activityId);
    assert.equal(links.length, 1, "re-running must not duplicate the trail_links row");

    const { rows } = await pool.query("select count(*) as count from trails where id = $1", [
      first.trailId,
    ]);
    assert.equal(Number(rows[0].count), 1, "re-running must not found a second trail");
  });
});

test("the trail's canonical_geom is the longest linked track, not an average", async () => {
  await withCleanup(async (resources) => {
    const shortTrack = loadTrack("fixtures/trail-pairs/out-and-back/a.gpx");
    const longTrack = loadTrack("fixtures/trail-pairs/out-and-back/b.gpx");

    const shortActivityId = await createActivity(user.id, "Turnaround only", shortTrack);
    const longActivityId = await createActivity(user.id, "Full out-and-back", longTrack);
    resources.activityIds.push(shortActivityId, longActivityId);

    const shortOutcome = await asUser(user.id, (client) => matchActivityToTrail(client, shortActivityId));
    resources.trailIds.add(shortOutcome.trailId);
    assert.equal(shortOutcome.classification, "founded");

    const longOutcome = await asUser(user.id, (client) => matchActivityToTrail(client, longActivityId));
    resources.trailIds.add(longOutcome.trailId);
    assert.equal(longOutcome.classification, "auto");
    assert.equal(longOutcome.trailId, shortOutcome.trailId);

    const matchesLong = await canonicalGeomEquals(user.id, shortOutcome.trailId, longActivityId);
    const matchesShort = await canonicalGeomEquals(user.id, shortOutcome.trailId, shortActivityId);
    assert.equal(matchesLong, true, "canonical_geom must equal the longer (full) track");
    assert.equal(matchesShort, false, "canonical_geom must not still be the shorter (truncated) track");
  });
});

test("recountTrailEntries counts only publicly visible entries", async () => {
  await withCleanup(async (resources) => {
    const track = loadTrack("fixtures/gpx/2026-08-15-morning-hike-hike.gpx");
    const activityId = await createActivity(user.id, "Recount check", track);
    resources.activityIds.push(activityId);

    const outcome = await asUser(user.id, (client) => matchActivityToTrail(client, activityId));
    resources.trailIds.add(outcome.trailId);

    const entryId = await createEntry(user.id, activityId, "Recount entry");
    resources.entryIds.push(entryId);
    await asUser(user.id, (client) =>
      client.query("update entries set trail_id = $1 where id = $2", [outcome.trailId, entryId]),
    );

    await asUser(user.id, (client) => recountTrailEntries(client, outcome.trailId));
    const draftCount = await pool.query("select public_entry_count from trails where id = $1", [
      outcome.trailId,
    ]);
    assert.equal(draftCount.rows[0].public_entry_count, 0, "a draft entry must not be counted");

    await asUser(user.id, (client) =>
      client.query(
        `update entries set status = 'published', slug = $2, published_at = now() where id = $1`,
        [entryId, `recount-${Date.now()}`],
      ),
    );
    await asUser(user.id, (client) => recountTrailEntries(client, outcome.trailId));
    const publishedCount = await pool.query("select public_entry_count from trails where id = $1", [
      outcome.trailId,
    ]);
    assert.equal(
      publishedCount.rows[0].public_entry_count,
      1,
      "a published public entry must be counted",
    );
  });
});
