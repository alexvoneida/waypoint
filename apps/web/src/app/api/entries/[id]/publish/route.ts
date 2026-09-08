import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import type { PoolClient } from "pg";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/http";
import { recountTrailEntries } from "@/lib/trail-match";

interface EntryRow {
  id: string;
  title: string;
  slug: string | null;
  status: string;
  trail_id: string | null;
}

// Lowercase, hyphenated, ASCII-folded: NFKD decomposition splits an accented
// letter into its base letter plus a combining mark, so stripping combining
// marks (U+0300-U+036F) after decomposing is what turns e.g. "Cotopaxi" (already
// ASCII) or "Peña Blanca" into "pena-blanca" rather than dropping the letter
// outright.
function slugify(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "entry";
}

/**
 * Assigns `slug` and publishes in one statement, retrying with `-2`, `-3`...
 * on a collision. A savepoint wraps each attempt: the surrounding request
 * runs in one transaction (withUser), and Postgres aborts an entire
 * transaction on a constraint violation unless the failing statement was
 * inside a savepoint that can be rolled back on its own, leaving the rest of
 * the transaction usable for the next attempt.
 */
async function publishWithUniqueSlug(
  client: PoolClient,
  entryId: string,
  baseSlug: string,
): Promise<string> {
  let candidate = baseSlug;
  let suffix = 2;
  for (;;) {
    await client.query("savepoint slug_attempt");
    try {
      await client.query(
        `update entries
           set slug = $2, status = 'published', published_at = coalesce(published_at, now())
         where id = $1`,
        [entryId, candidate],
      );
      await client.query("release savepoint slug_attempt");
      return candidate;
    } catch (error) {
      await client.query("rollback to savepoint slug_attempt");
      const pgError = error as { code?: string; constraint?: string };
      if (pgError.code === "23505" && pgError.constraint === "entries_user_id_slug_key") {
        candidate = `${baseSlug}-${suffix}`;
        suffix += 1;
        continue;
      }
      throw error;
    }
  }
}

async function publicUrlFor(client: PoolClient, userId: string, slug: string): Promise<string> {
  const { rows } = await client.query<{ handle: string }>("select handle from users where id = $1", [
    userId,
  ]);
  const handle = rows[0]?.handle;
  if (!handle) {
    throw new Error(`user not found while building public url: ${userId}`);
  }
  return `/e/${handle}/${slug}`;
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }
  const { id: entryId } = await context.params;

  const result = await withUser(userId, async (client) => {
    // RLS (entries_own) already scopes this to the caller's own entries, so a
    // missing row means "not yours" and "doesn't exist" both, exactly as in
    // POST /api/entries.
    const { rows } = await client.query<EntryRow>(
      "select id, title, slug, status, trail_id from entries where id = $1",
      [entryId],
    );
    const entry = rows[0];
    if (!entry) {
      return { notFound: true as const };
    }

    // Idempotent: a second publish of an already-published entry is a no-op
    // on the slug, not a fresh assignment -- re-running slugify against the
    // same title would happen to produce the same base slug today, but
    // re-running the whole dedupe search is still the wrong thing to do a
    // second time, since by then this entry's own slug is one of the rows the
    // search would collide against.
    const slug = entry.status === "published" && entry.slug
      ? entry.slug
      : await publishWithUniqueSlug(client, entry.id, slugify(entry.title));

    // public_entry_count only ever reflects entries visible_entries can see,
    // so publishing (the only thing that can add this entry to that view) is
    // exactly when the trail's count can change. An entry with no trail yet
    // -- trail.match has not run, or has not been triggered -- has nothing to
    // recount.
    if (entry.trail_id) {
      await recountTrailEntries(client, entry.trail_id);
    }

    const url = await publicUrlFor(client, userId, slug);
    return { notFound: false as const, id: entry.id, slug, url };
  });

  if (result.notFound) {
    return jsonError(404, "Entry not found");
  }

  revalidatePath(result.url);
  revalidatePath("/");

  return jsonOk({ id: result.id, slug: result.slug, url: result.url });
}
