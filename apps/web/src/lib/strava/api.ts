/**
 * The Strava HTTP surface, and nothing else: no database, no encryption, no
 * session. Every endpoint used here was confirmed outside the September 2026
 * deprecation list during Phase 0 (§14).
 */
const OAUTH_BASE = "https://www.strava.com/oauth";
const API_BASE = "https://www.strava.com/api/v3";
const REQUEST_TIMEOUT_MS = 20_000;

export class StravaApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Thrown on 429. `resetAt` is when the exhausted window rolls over, which is
 * what N-3's "degrade visibly" needs: a caller can say when work resumes
 * rather than only that it stopped.
 */
export class StravaRateLimitError extends Error {
  constructor(readonly resetAt: Date) {
    super(`Strava rate limit reached; resets at ${resetAt.toISOString()}`);
  }
}

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string;
  athleteId: number;
}

export interface StravaSummaryActivity {
  id: number;
  name: string;
  sportType: string;
  startDate: Date;
  utcOffsetSeconds: number;
  timezone: string | null;
  distanceM: number;
  ascentM: number | null;
  movingS: number | null;
  elapsedS: number;
}

export interface StravaStreams {
  latlng: [number, number][];
  time: number[];
  altitude: number[] | null;
}

export function authorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv("STRAVA_CLIENT_ID"),
    redirect_uri: requireEnv("STRAVA_REDIRECT_URI"),
    response_type: "code",
    // Strava re-prompts only with `force`; without it a user who revoked
    // access in Strava's own settings is bounced straight back with the old
    // (now useless) grant and no way to re-consent.
    approval_prompt: "force",
    scope: "read,activity:read_all",
    state,
  });
  return `${OAUTH_BASE}/authorize?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<StravaTokens> {
  return tokenRequest({ code, grant_type: "authorization_code" });
}

export async function refreshTokens(refreshToken: string): Promise<StravaTokens> {
  return tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
}

export async function deauthorize(accessToken: string): Promise<void> {
  const response = await fetch(`${OAUTH_BASE}/deauthorize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // 401 means the grant is already gone -- the user revoked it in Strava's
  // settings, or a previous disconnect got as far as this call and no
  // further. Either way the desired state is reached, so it is not an error.
  if (!response.ok && response.status !== 401) {
    throw await apiError(response);
  }
}

export interface ListActivitiesOptions {
  /** Returns activities strictly older than this. The paging cursor. */
  before?: Date;
  perPage: number;
}

export async function listActivities(
  accessToken: string,
  options: ListActivitiesOptions,
): Promise<StravaSummaryActivity[]> {
  const params = new URLSearchParams({ per_page: String(options.perPage) });
  if (options.before) {
    params.set("before", String(Math.floor(options.before.getTime() / 1000)));
  }
  const payload = await getJson<unknown[]>(
    accessToken,
    `${API_BASE}/athlete/activities?${params.toString()}`,
  );
  return payload.map(toSummaryActivity);
}

export async function getStreams(
  accessToken: string,
  activityId: number,
): Promise<StravaStreams | null> {
  const url = `${API_BASE}/activities/${activityId}/streams?keys=latlng,time,altitude&key_by_type=true`;
  const payload = await getJson<Record<string, { data?: unknown[] } | undefined>>(
    accessToken,
    url,
  );

  const latlng = payload.latlng?.data as [number, number][] | undefined;
  const time = payload.time?.data as number[] | undefined;
  // An indoor or manually-entered activity has no position stream at all.
  // That is an ordinary outcome, not a failure, so it reads as null and the
  // caller decides what to say about it.
  if (!latlng?.length || !time?.length) return null;

  const altitude = (payload.altitude?.data as number[] | undefined) ?? null;
  return { latlng, time, altitude };
}

async function tokenRequest(extra: Record<string, string>): Promise<StravaTokens> {
  const response = await fetch(`${OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("STRAVA_CLIENT_ID"),
      client_secret: requireEnv("STRAVA_CLIENT_SECRET"),
      ...extra,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await apiError(response);

  const payload = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    scope?: string;
    athlete?: { id?: number };
  };

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(payload.expires_at * 1000),
    // A refresh response carries no `scope`; only the code exchange does. The
    // caller keeps the scopes it already stored in that case.
    scopes: payload.scope ?? "",
    athleteId: payload.athlete?.id ?? 0,
  };
}

async function getJson<T>(accessToken: string, url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 429) {
    throw new StravaRateLimitError(rateLimitResetAt(response));
  }
  if (!response.ok) throw await apiError(response);
  return (await response.json()) as T;
}

/**
 * Strava's short-term limit is a fixed 15-minute window aligned to the clock,
 * so the reset is the next quarter hour. `x-ratelimit-usage` reports usage
 * but never a reset time, and there is no Retry-After on these responses --
 * the window boundary has to be computed rather than read.
 */
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

function rateLimitResetAt(response: Response): Date {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return new Date(Date.now() + retryAfter * 1000);
  }
  const now = Date.now();
  return new Date(Math.ceil(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS);
}

async function apiError(response: Response): Promise<StravaApiError> {
  // Strava's error bodies are small JSON documents; the text is kept for the
  // server log and never returned to a browser, since it can name the
  // application's own client_id.
  const body = await response.text().catch(() => "");
  return new StravaApiError(response.status, `Strava returned ${response.status}: ${body}`);
}

function toSummaryActivity(raw: unknown): StravaSummaryActivity {
  const activity = raw as Record<string, unknown>;
  return {
    id: Number(activity.id),
    name: String(activity.name ?? "Untitled activity"),
    sportType: String(activity.sport_type ?? activity.type ?? "Unknown"),
    startDate: new Date(String(activity.start_date)),
    // §4's Phase 0 finding: `utc_offset` is the offset in force on the day;
    // the `(GMT-07:00)` prefix inside `timezone` is the zone's standard
    // offset and is an hour wrong through the whole hiking season. Only the
    // IANA half of that label is kept, and only for display.
    utcOffsetSeconds: Number(activity.utc_offset ?? 0),
    timezone: ianaZone(activity.timezone),
    distanceM: Number(activity.distance ?? 0),
    ascentM: numberOrNull(activity.total_elevation_gain),
    movingS: numberOrNull(activity.moving_time),
    elapsedS: Number(activity.elapsed_time ?? 0),
  };
}

function ianaZone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const withoutPrefix = raw.replace(/^\(GMT[^)]*\)\s*/, "").trim();
  return withoutPrefix || null;
}

function numberOrNull(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
