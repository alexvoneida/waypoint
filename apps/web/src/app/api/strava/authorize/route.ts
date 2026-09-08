import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { authorizationUrl } from "@/lib/strava/api";

const NONCE_BYTES = 32;
const NONCE_LIFETIME_MS = 10 * 60 * 1000;

export async function GET(request: NextRequest) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }

  // The nonce is stored server-side and bound to this user, so the callback
  // can establish that the code it was handed answers an authorization this
  // session actually started. A nonce held only in a cookie would be chosen
  // by whoever controls the browser, which is the CSRF this guards against.
  const nonce = randomBytes(NONCE_BYTES).toString("base64url");
  await withUser(userId, async (client) => {
    // Expired nonces are cleared on the way past rather than by a scheduled
    // job: this table is written once per connection attempt, so the sweep is
    // cheap and there is no other natural moment to run it.
    await client.query(`delete from strava_oauth_states where expires_at < now()`);
    await client.query(
      `insert into strava_oauth_states (nonce, user_id, expires_at) values ($1, $2, $3)`,
      [nonce, userId, new Date(Date.now() + NONCE_LIFETIME_MS)],
    );
  });

  return NextResponse.redirect(authorizationUrl(nonce));
}
