import { z } from "zod";
import type { NextRequest } from "next/server";
import { readPublic } from "@/lib/db";
import { clientIp, jsonError, jsonOk, parseBody } from "@/lib/http";
import { checkRateLimit } from "@/lib/rate-limit";

const bodySchema = z.object({
  email: z.string().email(),
});

export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  const limit = checkRateLimit(`waitlist:${ip}`, { limit: 3, windowMs: 60 * 60 * 1000 });
  if (!limit.allowed) {
    return jsonError(429, "Too many attempts. Try again later.", {
      retryAfterSeconds: limit.retryAfterSeconds,
    });
  }

  const parsed = await parseBody(request, bodySchema);
  if (!parsed.ok) return parsed.response;

  // on conflict do nothing, and one success response either way: a distinct
  // "already on the list" response would let a visitor test arbitrary emails
  // against the waitlist one at a time.
  await readPublic((client) =>
    client.query(`insert into waitlist_signups (email) values ($1) on conflict do nothing`, [
      parsed.data.email,
    ]),
  );

  return jsonOk({ ok: true });
}
