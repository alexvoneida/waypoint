#!/usr/bin/env node
// Mints a redeemable invite code against a real database, using the owner
// connection -- the same operator action /api/invites/dev-issue stands in
// for in development, but that route 404s in production by design (§ invite
// system: issuing an invite is an operator action, not something the running
// app does for itself; invites has no insert policy at all, per
// db/migrations/0003_rls.sql). This script is that operator action, run by
// hand against DATABASE_ADMIN_URL, which never reaches the deployed app.
//
//   node scripts/issue-invite.mjs [issuedTo] [expiresInDays]
//
// issuedTo is optional and only a label (invites.issued_to) -- it does not
// restrict who can redeem the code, since redemption asks for its own email.
// expiresInDays defaults to 14.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function loadEnv() {
  const path = join(REPO_ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

async function main() {
  const issuedTo = process.argv[2] || null;
  const expiresInDays = Number(process.argv[3] ?? 14);
  if (!Number.isFinite(expiresInDays) || expiresInDays <= 0) {
    throw new Error(`expiresInDays must be a positive number, got: ${process.argv[3]}`);
  }

  const connectionString = process.env.DATABASE_ADMIN_URL;
  if (!connectionString) {
    throw new Error("DATABASE_ADMIN_URL is not set -- this must run with the owner connection, never DATABASE_URL");
  }

  const pool = new pg.Pool({ connectionString });
  try {
    const code = randomUUID();
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    await pool.query(`insert into invites (code, issued_to, expires_at) values ($1, $2, $3)`, [
      code,
      issuedTo,
      expiresAt,
    ]);

    console.log(`code:       ${code}`);
    console.log(`issued to:  ${issuedTo ?? "(none)"}`);
    console.log(`expires at: ${expiresAt.toISOString()}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
