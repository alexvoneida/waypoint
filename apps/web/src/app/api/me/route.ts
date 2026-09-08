import type { NextRequest } from "next/server";
import { withUser } from "@/lib/db";
import { getViewer } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";

export async function GET(request: NextRequest) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Not signed in");
  }

  const { rows } = await withUser(userId, (client) =>
    client.query<{
      handle: string;
      display_name: string;
      email: string;
      profile_visibility: string;
    }>(
      `select handle, display_name, email, profile_visibility
       from users where id = $1`,
      [userId],
    ),
  );

  const user = rows[0];
  if (!user) {
    return jsonError(401, "Not signed in");
  }

  return jsonOk({
    handle: user.handle,
    displayName: user.display_name,
    email: user.email,
    profileVisibility: user.profile_visibility,
  });
}
