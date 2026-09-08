import { randomBytes, createHash } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import type { NextRequest } from "next/server";
import { readPublic, withUser } from "./db";

export const SESSION_COOKIE_NAME = "waypoint_session";
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SECRET_BYTES = 32;

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return argon2Verify(passwordHash, password);
}

// Verified on every sign-in attempt, even against an email that does not
// exist, so that argon2's cost dominates the response time either way and a
// visitor cannot tell registered emails from unregistered ones by latency.
// Computed lazily (argon2 is async, so this cannot be a module-level constant)
// and cached, since the hash itself never needs to change.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2Hash("waypoint-dummy-password-for-timing-parity");
  }
  return dummyHashPromise;
}

export async function verifyPasswordTimingSafe(
  passwordHash: string | null,
  password: string,
): Promise<boolean> {
  const hashToCheck = passwordHash ?? (await getDummyHash());
  const matches = await argon2Verify(hashToCheck, password);
  return passwordHash !== null && matches;
}

// The token is 32 bytes of randomness and nothing else. It deliberately
// carries no user id: a token travels through proxy logs, crash reports and
// devtools, and one that names its account leaks that account's identity and
// makes two tokens linkable to the same person.
//
// Sessions are RLS-scoped to their owner, so a lookup keyed on the token alone
// cannot see the row - the caller has no identity until the token resolves.
// session_lookup (0007) closes exactly that gap, the same way auth_lookup does
// for sign-in, so the token needs no routing information of its own.
function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export async function createSession(userId: string, userAgent: string | null): Promise<string> {
  const token = randomBytes(SECRET_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await withUser(userId, (client) =>
    client.query(
      `insert into sessions (user_id, token_hash, expires_at, user_agent)
       values ($1, $2, $3, $4)`,
      [userId, hashToken(token), expiresAt, userAgent],
    ),
  );
  return token;
}

export async function resolveSession(token: string): Promise<string | null> {
  if (!token) return null;
  // The stored value is a hash of the token, so the database comparison is
  // against a digest rather than the credential itself. An attacker who
  // obtains the table still has to invert SHA-256 to get a usable token.
  const { rows } = await readPublic((client) =>
    client.query<{ user_id: string }>(`select user_id from session_lookup($1)`, [hashToken(token)]),
  );
  return rows[0]?.user_id ?? null;
}

export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  await readPublic((client) =>
    client.query(`select session_revoke($1)`, [hashToken(token)]),
  );
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/" as const,
    maxAge: maxAgeSeconds,
  };
}

export const SESSION_LIFETIME_SECONDS = SESSION_LIFETIME_MS / 1000;

// Accepts either the httpOnly cookie a browser sends automatically or an
// `Authorization: Bearer` header, in that order, so a native client (mobile
// app, CLI) can authenticate the same way a browser session does without any
// endpoint needing separate auth wiring added later.
export async function getViewer(request: NextRequest): Promise<string | null> {
  const cookieToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const token = cookieToken ?? bearerToken(request);
  if (!token) return null;
  return resolveSession(token);
}

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return null;
  return value;
}
