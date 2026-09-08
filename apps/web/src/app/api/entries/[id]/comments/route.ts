import { z } from "zod";
import type { NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError, jsonOk, parseBody } from "@/lib/http";
import { checkRateLimit } from "@/lib/rate-limit";

const bodySchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }

  // Per user rather than per IP: this endpoint needs a session, so the
  // account is the identity worth budgeting, and one account behind a
  // changing address is the case a per-IP window would miss.
  const limit = checkRateLimit(`comments:${userId}`, { limit: 10, windowMs: 60 * 1000 });
  if (!limit.allowed) {
    return jsonError(429, "Too many comments. Try again shortly.", {
      retryAfterSeconds: limit.retryAfterSeconds,
    });
  }

  const { id: entryId } = await context.params;
  const parsed = await parseBody(request, bodySchema);
  if (!parsed.ok) return parsed.response;

  try {
    const { rows } = await withUser(userId, (client) =>
      client.query<{ id: string; created_at: string }>(
        `insert into comments (entry_id, user_id, body)
         values ($1, $2, $3)
         returning id, created_at`,
        [entryId, userId, parsed.data.body],
      ),
    );
    const comment = rows[0]!;
    return jsonOk({ id: comment.id, createdAt: comment.created_at }, { status: 201 });
  } catch (error) {
    // comments_insert (0003) already requires the entry to be in
    // visible_entries and to have comments_open. Repeating either check here
    // would be a second resolution point for the thing §9 insists on having
    // exactly one of, so the policy's own refusal is what this reads.
    if ((error as { code?: string }).code === "42501") {
      return jsonError(403, "Comments are closed on this outing");
    }
    throw error;
  }
}
