import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { z } from "zod";

export function jsonError(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export type ParseBodyResult<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

export async function parseBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<ParseBodyResult<z.infer<Schema>>> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return { ok: false, response: jsonError(400, "Request body must be valid JSON") };
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      response: jsonError(400, "Invalid request body", { issues: result.error.flatten() }),
    };
  }
  return { ok: true, data: result.data };
}

// Next.js 16 dropped NextRequest.ip; the platform in front of the app (a
// proxy, or Vercel) is expected to set x-forwarded-for. The first entry is
// the original client - trusted here because Phase 2 has no proxy layer of
// its own to spoof it past.
export function clientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return (forwardedFor.split(",")[0] ?? "unknown").trim();
  return "unknown";
}
