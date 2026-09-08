import type { NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/http";
import { resolveEntryForViewer } from "@/lib/social";

// Neither handler revalidates anything. Like counts are read client-side from
// /api/entries/:id/social precisely so that liking does not invalidate a
// cached entry page -- which is the whole reason §6 leaves the count out of
// the entries row rather than denormalising it there.

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }
  const { id: entryId } = await context.params;

  const found = await withUser(userId, async (client) => {
    // Resolving the entry first turns "you may not like this" into the same
    // 404 a missing entry gives, rather than leaving the policy on the insert
    // below to surface as a 500.
    if (!(await resolveEntryForViewer(client, entryId))) return false;

    // The primary key is the idempotency (S-2): a second like is a no-op
    // decided by the constraint, not by a preceding existence check that two
    // concurrent requests could both pass.
    await client.query(
      "insert into likes (entry_id, user_id) values ($1, $2) on conflict do nothing",
      [entryId, userId],
    );
    return true;
  });

  return found ? jsonOk({ ok: true }) : jsonError(404, "Entry not found");
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }
  const { id: entryId } = await context.params;

  // Unliking something that was never liked leaves the caller in the state
  // they asked for, so it succeeds rather than reporting a miss.
  await withUser(userId, (client) =>
    client.query("delete from likes where entry_id = $1 and user_id = $2", [entryId, userId]),
  );

  return jsonOk({ ok: true });
}
