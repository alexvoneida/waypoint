import type { PoolClient } from "pg";
import { decryptToken, encryptToken } from "./crypto";
import { refreshTokens, type StravaTokens } from "./api";

export type BackfillStatus = "none" | "listing" | "ready" | "importing" | "done";

export interface StravaConnection {
  athleteId: string;
  scopes: string;
  expiresAt: Date;
  backfillStatus: BackfillStatus;
  backfillCursor: Date | null;
  rateLimitedUntil: Date | null;
  listingError: string | null;
}

interface ConnectionRow {
  athlete_id: string;
  scopes: string;
  expires_at: Date;
  backfill_status: BackfillStatus;
  backfill_cursor: Date | null;
  rate_limited_until: Date | null;
  listing_error: string | null;
}

interface TokenRow extends ConnectionRow {
  access_token_encrypted: Buffer;
  refresh_token_encrypted: Buffer;
}

/**
 * Refreshed this far before the recorded expiry. Strava's tokens last six
 * hours, so a minute of clock skew or a slow job would otherwise be enough
 * for a token that looked valid at the check to be rejected at the call.
 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export async function readConnection(
  client: PoolClient,
  userId: string,
): Promise<StravaConnection | null> {
  const { rows } = await client.query<ConnectionRow>(
    `select athlete_id, scopes, expires_at, backfill_status, backfill_cursor,
            rate_limited_until, listing_error
     from strava_connections where user_id = $1`,
    [userId],
  );
  const row = rows[0];
  return row ? toConnection(row) : null;
}

export async function saveConnection(
  client: PoolClient,
  userId: string,
  tokens: StravaTokens,
): Promise<void> {
  // Reconnecting resets the backfill rather than preserving it: the new grant
  // may cover a different athlete, or the same one after activities were
  // added or deleted, and a cursor from the previous grant would resume a
  // scan through a list that no longer matches.
  await client.query(
    `insert into strava_connections
       (user_id, athlete_id, access_token_encrypted, refresh_token_encrypted,
        expires_at, scopes, backfill_status, backfill_cursor,
        rate_limited_until, listing_error)
     values ($1, $2, $3, $4, $5, $6, 'none', null, null, null)
     on conflict (user_id) do update set
       athlete_id              = excluded.athlete_id,
       access_token_encrypted  = excluded.access_token_encrypted,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       expires_at              = excluded.expires_at,
       scopes                  = excluded.scopes,
       backfill_status         = 'none',
       backfill_cursor         = null,
       rate_limited_until      = null,
       listing_error           = null`,
    [
      userId,
      tokens.athleteId,
      encryptToken(tokens.accessToken),
      encryptToken(tokens.refreshToken),
      tokens.expiresAt,
      tokens.scopes,
    ],
  );
}

export async function deleteConnection(client: PoolClient, userId: string): Promise<void> {
  await client.query(`delete from strava_connections where user_id = $1`, [userId]);
}

/**
 * The current access token, refreshed in place if it is at or near expiry.
 * Every caller goes through this rather than reading the column, which is
 * what makes N-1's "refresh happens transparently" true by construction
 * instead of by each caller remembering to check.
 *
 * Returns null when there is no connection at all -- a disconnected account
 * is an ordinary state, not an error.
 */
export async function getAccessToken(
  client: PoolClient,
  userId: string,
): Promise<string | null> {
  const { rows } = await client.query<TokenRow>(
    `select access_token_encrypted, refresh_token_encrypted, expires_at, scopes,
            athlete_id, backfill_status, backfill_cursor, rate_limited_until, listing_error
     from strava_connections where user_id = $1
     for update`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;

  if (row.expires_at.getTime() - REFRESH_SKEW_MS > Date.now()) {
    return decryptToken(row.access_token_encrypted);
  }

  const refreshed = await refreshTokens(decryptToken(row.refresh_token_encrypted));
  await client.query(
    `update strava_connections
       set access_token_encrypted = $2, refresh_token_encrypted = $3, expires_at = $4
     where user_id = $1`,
    [
      userId,
      encryptToken(refreshed.accessToken),
      // Strava rotates the refresh token on some refreshes and returns the
      // existing one otherwise; either way the response's value is the one
      // to store.
      encryptToken(refreshed.refreshToken),
      refreshed.expiresAt,
    ],
  );
  return refreshed.accessToken;
}

/**
 * The access token plus the refresh token, for disconnect: deauthorizing at
 * Strava needs a live access token, and if refreshing fails the disconnect
 * must still delete the row locally rather than stranding the account.
 */
export async function readAccessTokenForRevocation(
  client: PoolClient,
  userId: string,
): Promise<string | null> {
  try {
    return await getAccessToken(client, userId);
  } catch (error) {
    console.error(`could not obtain a Strava access token to revoke for ${userId}:`, error);
    return null;
  }
}

export async function setBackfillStatus(
  client: PoolClient,
  userId: string,
  status: BackfillStatus,
): Promise<void> {
  await client.query(
    `update strava_connections set backfill_status = $2 where user_id = $1`,
    [userId, status],
  );
}

function toConnection(row: ConnectionRow): StravaConnection {
  return {
    athleteId: String(row.athlete_id),
    scopes: row.scopes,
    expiresAt: row.expires_at,
    backfillStatus: row.backfill_status,
    backfillCursor: row.backfill_cursor,
    rateLimitedUntil: row.rate_limited_until,
    listingError: row.listing_error,
  };
}
