import type { NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/http";
import { deauthorize } from "@/lib/strava/api";
import { deleteConnection, readAccessTokenForRevocation } from "@/lib/strava/connection";

export async function POST(request: NextRequest) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }

  const accessToken = await withUser(userId, (client) =>
    readAccessTokenForRevocation(client, userId),
  );
  if (!accessToken) {
    // Nothing to revoke -- either there is no connection, or its refresh
    // token is already dead. Deleting locally is still the right outcome, so
    // this falls through rather than reporting an error.
    await withUser(userId, (client) => deleteConnection(client, userId));
    return jsonOk({ disconnected: true, revokedAtStrava: false });
  }

  // Revoke first, delete second. The other order can leave a live grant with
  // no local record of it, which is a permission the user believes they
  // withdrew. Revocation failing is not fatal -- the tokens still go -- but
  // it is reported, because the grant then has to be removed in Strava's own
  // settings and the user should be told so.
  let revokedAtStrava = true;
  try {
    await deauthorize(accessToken);
  } catch (error) {
    revokedAtStrava = false;
    console.error(`Strava deauthorize failed for ${userId}:`, error);
  }

  await withUser(userId, async (client) => {
    await deleteConnection(client, userId);
    // The cached listing goes with the connection. It is derived from a grant
    // that no longer exists, and keeping it would show a disconnected account
    // a list it can no longer import from.
    await client.query(`delete from strava_activities where user_id = $1`, [userId]);
  });

  return jsonOk({ disconnected: true, revokedAtStrava });
}
