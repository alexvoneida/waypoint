import type { PoolClient } from "pg";
import { withUser } from "./db";

export interface SocialComment {
  id: string;
  body: string;
  createdAt: string;
  authorHandle: string;
  authorDisplayName: string;
  /** Whether the asking viewer may remove it: its author, or the entry's. */
  canDelete: boolean;
}

export interface EntrySocial {
  likeCount: number;
  viewerLiked: boolean;
  commentsOpen: boolean;
  canInteract: boolean;
  comments: SocialComment[];
}

interface EntryRow {
  id: string;
  user_id: string;
  comments_open: boolean;
}

/**
 * The entry as this viewer may see it, or null.
 *
 * A union rather than a branch: the public arm reads visible_entries, the one
 * relation that resolves across accounts, and the owner arm reads the
 * RLS-scoped base table, which answers only for its own rows. §9 asks for a
 * viewer id as the input rather than an `if (isOwner)` at the call site, and
 * this is what that looks like -- adding followers changes the view, not this
 * function.
 */
export async function resolveEntryForViewer(
  client: PoolClient,
  entryId: string,
): Promise<EntryRow | null> {
  const { rows } = await client.query<EntryRow>(
    `select id, user_id, comments_open from visible_entries where id = $1
     union
     select id, user_id, comments_open from entries where id = $1`,
    [entryId],
  );
  return rows[0] ?? null;
}

export async function loadEntrySocial(
  entryId: string,
  viewerId: string | null,
): Promise<EntrySocial | null> {
  return withUser(viewerId, async (client) => {
    const entry = await resolveEntryForViewer(client, entryId);
    if (!entry) return null;

    // Both reads are already scoped by likes_visible and comments_visible,
    // which resolve through visible_entries with the acting user as the
    // viewer -- the same resolution, not a second copy of it.
    const [likes, comments] = await Promise.all([
      client.query<{ like_count: string; viewer_liked: boolean }>(
        `select
           count(*) as like_count,
           coalesce(bool_or(user_id = $2), false) as viewer_liked
         from likes where entry_id = $1`,
        [entryId, viewerId],
      ),
      client.query<{
        id: string;
        body: string;
        created_at: string;
        handle: string;
        display_name: string;
        user_id: string;
      }>(
        // deleted_at is filtered here rather than left to the policy: 0013
        // widened comments_visible to let a deleter still see the row they
        // hid, which is what makes the soft delete itself possible, so the
        // read has to say that it wants only the living ones.
        `select c.id, c.body, c.created_at, c.user_id, p.handle, p.display_name
         from comments c
         join public_profiles p on p.id = c.user_id
         where c.entry_id = $1 and c.deleted_at is null
         order by c.created_at asc`,
        [entryId],
      ),
    ]);

    const likeRow = likes.rows[0];
    return {
      likeCount: Number(likeRow?.like_count ?? 0),
      viewerLiked: likeRow?.viewer_liked ?? false,
      commentsOpen: entry.comments_open,
      // Dormant while signup is closed: the author is the only account, so
      // the only person who can like or comment is themselves. The path is
      // built and tested so opening signup is a switch, not a project (§9).
      canInteract: viewerId !== null,
      comments: comments.rows.map((row) => ({
        id: row.id,
        body: row.body,
        createdAt: row.created_at,
        authorHandle: row.handle,
        authorDisplayName: row.display_name,
        canDelete: viewerId !== null && (row.user_id === viewerId || entry.user_id === viewerId),
      })),
    };
  });
}
