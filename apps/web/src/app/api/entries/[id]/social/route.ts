import type { NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { loadEntrySocial } from "@/lib/social";

// The deliberately uncached half of the entry page. That page is statically
// generated and revalidated on publish; a like count baked into it would mean
// regenerating the whole thing on every like, so the page ships without one
// and asks for it here on mount (§7).
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  // Conditional auth: a visitor reads counts and comments without a session,
  // and the viewer id only decides what they may do about them.
  const viewerId = await getViewer(request);
  const { id: entryId } = await context.params;

  const social = await loadEntrySocial(entryId, viewerId);
  if (!social) {
    return jsonError(404, "Entry not found");
  }

  return jsonOk(social);
}
