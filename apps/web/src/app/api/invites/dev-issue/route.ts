import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { jsonOk } from "@/lib/http";

// Development-only: mints a redeemable invite code without going through
// whatever out-of-band process (email, a founder's personal invite) issues
// them in production, so the signup flow can be walked end to end locally
// and in tests. Gated on NODE_ENV rather than removed outright because the
// walk-through in the Phase 2 verification step needs it - but it must never
// ship reachable: a live 404 here would let anyone mint their own account
// without ever holding a real invite.
//
// invites has no insert policy at all (0003_rls.sql) - by design, issuing an
// invite is an operator action, not something the running app does for
// itself. This endpoint stands in for that operator, so it is the one place
// in the app that legitimately reaches for DATABASE_ADMIN_URL, scoped to a
// pool that exists only in this file and is never exported for another route
// to pick up.
let devAdminPool: Pool | null = null;
function getDevAdminPool(): Pool {
  if (!devAdminPool) {
    const connectionString = process.env.DATABASE_ADMIN_URL;
    if (!connectionString) throw new Error("DATABASE_ADMIN_URL is not set");
    devAdminPool = new Pool({ connectionString });
  }
  return devAdminPool;
}

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return new Response(null, { status: 404 });
  }

  const code = randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await getDevAdminPool().query(`insert into invites (code, expires_at) values ($1, $2)`, [
    code,
    expiresAt,
  ]);

  return jsonOk({ code, expiresAt });
}
