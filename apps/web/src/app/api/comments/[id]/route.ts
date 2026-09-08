import type { NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/http";

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }
  const { id: commentId } = await context.params;

  const { rowCount } = await withUser(userId, (client) =>
    // Soft, because S-3 asks for it: a hard delete leaves a thread with holes
    // in it, and a reader cannot tell a removed comment from one that was
    // never written. comments_delete (0003) is what restricts this to the
    // comment's author or the entry's, so the update carries no second check
    // of its own.
    client.query(
      `update comments
         set deleted_at = now(), deleted_by = $2
       where id = $1 and deleted_at is null`,
      [commentId, userId],
    ),
  );

  // Zero rows means the comment is not yours to remove, is already gone, or
  // never existed. A 403 for the first of those would confirm it exists (§9).
  return rowCount ? jsonOk({ ok: true }) : jsonError(404, "Comment not found");
}
