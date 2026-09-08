import { z } from "zod";
import type { NextRequest } from "next/server";
import { readPublic } from "@/lib/db";
import {
  createSession,
  sessionCookieOptions,
  verifyPasswordTimingSafe,
  SESSION_COOKIE_NAME,
  SESSION_LIFETIME_SECONDS,
} from "@/lib/auth";
import { clientIp, jsonError, jsonOk, parseBody } from "@/lib/http";
import { checkRateLimit } from "@/lib/rate-limit";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const parsed = await parseBody(request, bodySchema);
  if (!parsed.ok) return parsed.response;
  const { email, password } = parsed.data;

  const ip = clientIp(request);
  const ipLimit = checkRateLimit(`signin:ip:${ip}`, { limit: 10, windowMs: 15 * 60 * 1000 });
  const emailLimit = checkRateLimit(`signin:email:${email.toLowerCase()}`, {
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  if (!ipLimit.allowed || !emailLimit.allowed) {
    return jsonError(429, "Too many attempts. Try again later.", {
      retryAfterSeconds: Math.max(ipLimit.retryAfterSeconds, emailLimit.retryAfterSeconds),
    });
  }

  // users_select_self only ever shows a row to itself, which is what a
  // sign-in attempt has not established yet. auth_lookup (0004_auth_lookup.sql)
  // is a narrow security-definer function that exists to bridge exactly that
  // gap - see the migration's comment for why widening the select policy
  // instead would be worse.
  const { rows } = await readPublic((client) =>
    client.query<{ id: string; password_hash: string }>("select * from auth_lookup($1)", [email]),
  );
  const account = rows[0] ?? null;

  // Runs even when no account matched, against a fixed dummy hash, so a
  // visitor cannot distinguish a wrong password from an unregistered email by
  // response timing.
  const passwordOk = await verifyPasswordTimingSafe(account?.password_hash ?? null, password);
  if (!account || !passwordOk) {
    return jsonError(401, "Incorrect email or password");
  }

  const token = await createSession(account.id, request.headers.get("user-agent"));
  const response = jsonOk({ token });
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(SESSION_LIFETIME_SECONDS));
  return response;
}
