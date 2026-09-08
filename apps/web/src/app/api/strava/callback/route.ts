import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { inngest } from "@/lib/jobs/client";
import { exchangeCode } from "@/lib/strava/api";
import { saveConnection } from "@/lib/strava/connection";

const STUDIO_STRAVA_PATH = "/studio/strava";

// Failures land back on the studio with a code in the query string rather
// than rendering an error here: this endpoint is reached by a browser
// redirect from Strava, so its only sensible response is to put the person
// somewhere that can explain what happened.
function backToStudio(request: NextRequest, error?: string): NextResponse {
  const url = new URL(STUDIO_STRAVA_PATH, request.nextUrl.origin);
  if (error) url.searchParams.set("error", error);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const userId = await getViewer(request);
  if (!userId) {
    return jsonError(401, "Sign in required");
  }

  const params = request.nextUrl.searchParams;
  if (params.get("error")) {
    return backToStudio(request, "denied");
  }

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    return backToStudio(request, "incomplete");
  }

  // Consumed by the delete itself, so the nonce is single-use even against
  // two callbacks arriving at once: only one deletion can return a row. The
  // policy on strava_oauth_states scopes this to the acting user, so a nonce
  // issued to another account matches nothing here.
  const consumed = await withUser(userId, (client) =>
    client.query<{ user_id: string }>(
      `delete from strava_oauth_states
       where nonce = $1 and expires_at > now()
       returning user_id`,
      [state],
    ),
  );
  if (consumed.rowCount === 0) {
    return backToStudio(request, "state");
  }

  let tokens;
  try {
    tokens = await exchangeCode(code);
  } catch (error) {
    // Strava's message can name the application's own client_id, so it goes
    // to the server log and the browser gets a code.
    console.error(`Strava code exchange failed for ${userId}:`, error);
    return backToStudio(request, "exchange");
  }

  // The granted scopes are Strava's answer, not the request's: a user can
  // uncheck the activity permission on the consent screen and still complete
  // the flow, which would leave a connection that can never list anything.
  if (!tokens.scopes.includes("activity:read")) {
    return backToStudio(request, "scope");
  }

  await withUser(userId, (client) => saveConnection(client, userId, tokens));

  // Best-effort, after the connection is committed, matching the pattern in
  // POST /api/activities: the connection succeeded, and a listing that failed
  // to enqueue is re-triggerable from the studio.
  await inngest
    .send({ name: "strava/backfill.requested", data: { userId } })
    .catch((error: unknown) => {
      console.error(`failed to enqueue strava/backfill.requested for ${userId}:`, error);
    });

  return backToStudio(request);
}
