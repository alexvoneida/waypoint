import type { NextRequest } from "next/server";
import { revokeSession, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth";
import { jsonOk } from "@/lib/http";

export async function POST(request: NextRequest) {
  const cookieToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const authHeader = request.headers.get("authorization");
  const bearerToken = authHeader?.toLowerCase().startsWith("bearer ") ? authHeader.slice(7) : null;
  const token = cookieToken ?? bearerToken;
  if (token) {
    await revokeSession(token);
  }

  const response = jsonOk({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions(0), maxAge: 0 });
  return response;
}
