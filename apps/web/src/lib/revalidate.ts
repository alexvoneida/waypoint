import { revalidatePath } from "next/cache";
import type { PoolClient } from "pg";

/**
 * The cached public paths a change to one entry can affect.
 *
 * Reads the base tables rather than `visible_entries`, and deliberately so:
 * this runs for a mutation that may have just made the entry invisible, and
 * the view no longer returns it. A purge driven by the view would skip
 * exactly the case that matters -- an account going private leaving its
 * cached pages served from the edge (§7, §9).
 *
 * The profile page is absent because it renders `force-dynamic`; it has no
 * cache entry to purge.
 */
export async function entryPaths(client: PoolClient, entryId: string): Promise<string[]> {
  const { rows } = await client.query<{
    handle: string;
    slug: string | null;
    trail_slug: string | null;
  }>(
    `select u.handle, e.slug, t.slug as trail_slug
     from entries e
     join users u on u.id = e.user_id
     left join trails t on t.id = e.trail_id
     where e.id = $1`,
    [entryId],
  );
  const row = rows[0];
  if (!row) return [];
  return pathsFor(row.handle, row.slug, row.trail_slug);
}

/**
 * Every cached path an account-level visibility change affects: one entry
 * page per published entry, every trail those entries appear on, and
 * discovery.
 *
 * A draft has no slug and no public page, so it contributes nothing. Every
 * *published* entry does, whatever its own visibility -- an entry that was
 * already private still needs its trail and discovery paths considered, and
 * one that was public needs its own page purged in both directions of the
 * toggle.
 */
export async function accountPaths(client: PoolClient, userId: string): Promise<string[]> {
  const { rows } = await client.query<{
    handle: string;
    slug: string;
    trail_slug: string | null;
  }>(
    `select u.handle, e.slug, t.slug as trail_slug
     from entries e
     join users u on u.id = e.user_id
     left join trails t on t.id = e.trail_id
     where e.user_id = $1 and e.status = 'published' and e.slug is not null`,
    [userId],
  );
  return rows.flatMap((row) => pathsFor(row.handle, row.slug, row.trail_slug));
}

function pathsFor(handle: string, slug: string | null, trailSlug: string | null): string[] {
  const paths = ["/"];
  if (slug) paths.push(`/e/${handle}/${slug}`);
  if (trailSlug) paths.push(`/t/${trailSlug}`);
  return paths;
}

/**
 * Call after the transaction that produced these paths has committed.
 * Revalidating earlier races the mutation: a regeneration triggered by the
 * purge can read the pre-commit state and cache it right back.
 */
export function purge(paths: Iterable<string>): void {
  for (const path of new Set(paths)) {
    revalidatePath(path);
  }
}
