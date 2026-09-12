import { NextResponse } from "next/server";
import { readPublic } from "@/lib/db";
import { pingBucket } from "@/lib/storage";

// Unauthenticated by design: this is what an uptime monitor or a post-deploy
// script hits to prove the two dependencies every request needs -- Postgres
// and the R2 bucket -- are actually reachable with the environment's
// configured credentials, not just that the Next.js process itself started.
// Inngest has no equivalent single-request ping; its own dashboard is the
// place to confirm the worker side is healthy.
export const dynamic = "force-dynamic";

interface CheckResult {
  ok: boolean;
  error?: string;
}

async function checkDatabase(): Promise<CheckResult> {
  try {
    await readPublic((client) => client.query("select 1"));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "unknown error" };
  }
}

async function checkStorage(): Promise<CheckResult> {
  try {
    await pingBucket();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "unknown error" };
  }
}

export async function GET() {
  const [database, storage] = await Promise.all([checkDatabase(), checkStorage()]);
  const ok = database.ok && storage.ok;
  return NextResponse.json({ ok, checks: { database, storage } }, { status: ok ? 200 : 503 });
}
