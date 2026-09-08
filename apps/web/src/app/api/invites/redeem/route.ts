import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { withUser } from "@/lib/db";
import { createSession, hashPassword, sessionCookieOptions, SESSION_COOKIE_NAME, SESSION_LIFETIME_SECONDS } from "@/lib/auth";
import { clientIp, jsonError, jsonOk, parseBody } from "@/lib/http";
import { checkRateLimit } from "@/lib/rate-limit";

const bodySchema = z.object({
  code: z.string().min(1),
  handle: z.string().min(2).max(32),
  email: z.string().email(),
  displayName: z.string().min(1).max(100),
  password: z.string().min(12),
});

class InvalidInviteError extends Error {}

export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  const limit = checkRateLimit(`invites:redeem:${ip}`, { limit: 5, windowMs: 60 * 60 * 1000 });
  if (!limit.allowed) {
    return jsonError(429, "Too many attempts. Try again later.", {
      retryAfterSeconds: limit.retryAfterSeconds,
    });
  }

  const parsed = await parseBody(request, bodySchema);
  if (!parsed.ok) return parsed.response;
  const { code, handle, email, displayName, password } = parsed.data;

  const passwordHash = await hashPassword(password);
  const userId = randomUUID();

  try {
    await withUser(null, async (client) => {
      // The user row must exist before the invite can reference it as
      // redeemed_by (a foreign key), so it is inserted first and rolled back
      // together with everything else if the invite turns out to be invalid.
      await client.query(
        `insert into users (id, handle, email, display_name, password_hash, profile_visibility)
         values ($1, $2, $3, $4, $5, 'private')`,
        [userId, handle, email, displayName, passwordHash],
      );

      // invites has no anonymous select policy, and Postgres requires a row
      // to pass an applicable SELECT policy before an UPDATE policy can
      // touch it - so a plain `update ... where` cannot validate and consume
      // the code here (see 0005_invite_redeem.sql). redeem_invite performs
      // that exact validated update as a security definer function instead.
      const { rows } = await client.query<{ redeem_invite: boolean | null }>(
        `select redeem_invite($1, $2)`,
        [code, userId],
      );
      if (!rows[0]?.redeem_invite) {
        throw new InvalidInviteError("invite code is invalid, expired, or already used");
      }
    });
  } catch (error) {
    if (error instanceof InvalidInviteError) {
      return jsonError(400, error.message);
    }
    const pgError = error as { code?: string; constraint?: string };
    if (pgError.code === "23505") {
      if (pgError.constraint === "users_handle_key") {
        return jsonError(409, "That handle is already taken");
      }
      if (pgError.constraint === "users_email_key") {
        return jsonError(409, "An account with that email already exists");
      }
      return jsonError(409, "That account already exists");
    }
    throw error;
  }

  const token = await createSession(userId, request.headers.get("user-agent"));
  const response = jsonOk({ token }, { status: 201 });
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(SESSION_LIFETIME_SECONDS));
  return response;
}
