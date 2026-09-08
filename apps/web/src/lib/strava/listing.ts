import type { PoolClient } from "pg";

/**
 * Reads the cached listing that N-2's selector renders. Never calls Strava:
 * the scan populates `strava_activities`, and paging or filtering the
 * selector must not cost a request against the rate limit.
 */

export interface ListingRow {
  stravaId: string;
  name: string;
  sportType: string;
  startDate: string;
  timezone: string | null;
  distanceM: number;
  ascentM: number | null;
  movingS: number | null;
  elapsedS: number;
  /** Set once imported; the selector renders these as already taken. */
  activityId: string | null;
  importedAt: string | null;
  importError: string | null;
}

export interface ListingFilters {
  sportType?: string;
  year?: number;
  /** Hides rows already imported, which is what an onboarding pass wants. */
  onlyUnimported?: boolean;
  limit: number;
  offset: number;
}

export interface ListingPage {
  activities: ListingRow[];
  total: number;
}

interface ListingDbRow {
  strava_id: string;
  name: string;
  sport_type: string;
  start_date: Date;
  timezone: string | null;
  distance_m: number;
  ascent_m: number | null;
  moving_s: number | null;
  elapsed_s: number;
  activity_id: string | null;
  imported_at: Date | null;
  import_error: string | null;
  total: string;
}

export async function loadListingPage(
  client: PoolClient,
  userId: string,
  filters: ListingFilters,
): Promise<ListingPage> {
  // The year filter compares against the activity's *local* date, not UTC:
  // an evening hike on 31 December in Denver is a December hike to the person
  // who walked it, and filtering on the UTC timestamp would file it under the
  // following year.
  const { rows } = await client.query<ListingDbRow>(
    `select strava_id, name, sport_type, start_date, timezone, distance_m,
            ascent_m, moving_s, elapsed_s, activity_id, imported_at, import_error,
            count(*) over () as total
     from strava_activities
     where user_id = $1
       and ($2::text is null or sport_type = $2)
       and ($3::int is null
            or extract(year from start_date + make_interval(secs => utc_offset_s)) = $3)
       and ($4::boolean is not true or activity_id is null)
     order by start_date desc
     limit $5 offset $6`,
    [
      userId,
      filters.sportType ?? null,
      filters.year ?? null,
      filters.onlyUnimported ?? false,
      filters.limit,
      filters.offset,
    ],
  );

  return {
    activities: rows.map(toListingRow),
    // count(*) over () produces no row at all on an empty page, so the total
    // falls back to 0 only when the filtered set is genuinely empty.
    total: rows[0] ? Number(rows[0].total) : 0,
  };
}

export interface ListingFacets {
  sportTypes: string[];
  years: number[];
}

/** The filter values the selector offers, drawn from what the account has. */
export async function loadListingFacets(
  client: PoolClient,
  userId: string,
): Promise<ListingFacets> {
  const { rows } = await client.query<{ sport_type: string; year: string }>(
    `select distinct sport_type,
            extract(year from start_date + make_interval(secs => utc_offset_s))::text as year
     from strava_activities
     where user_id = $1`,
    [userId],
  );

  return {
    sportTypes: [...new Set(rows.map((row) => row.sport_type))].sort(),
    years: [...new Set(rows.map((row) => Number(row.year)))].sort((a, b) => b - a),
  };
}

function toListingRow(row: ListingDbRow): ListingRow {
  return {
    // bigint arrives from pg as a string and stays one: Strava activity ids
    // are already past 2^53 territory for new activities, so parsing to a
    // JavaScript number would round some of them.
    stravaId: String(row.strava_id),
    name: row.name,
    sportType: row.sport_type,
    startDate: row.start_date.toISOString(),
    timezone: row.timezone,
    distanceM: row.distance_m,
    ascentM: row.ascent_m,
    movingS: row.moving_s,
    elapsedS: row.elapsed_s,
    activityId: row.activity_id,
    importedAt: row.imported_at?.toISOString() ?? null,
    importError: row.import_error,
  };
}
