import type { PoolClient } from "pg";
import { readPublic, withUser } from "./db";

export type Confidence = "high" | "medium" | "low";

export interface EntryPhoto {
  id: string;
  capturedAt: string | null;
  width: number | null;
  height: number | null;
  blurHash: string | null;
  lens: string | null;
  focalLength: number | null;
  aperture: number | null;
  iso: number | null;
  hasWeb: boolean;
  hasThumb: boolean;
  hasFull: boolean;
  location: {
    lon: number;
    lat: number;
    elevationM: number | null;
    distanceAlongM: number | null;
    confidence: Confidence;
  } | null;
}

export interface ElevationPoint {
  distanceM: number;
  elevationM: number;
}

export interface EntryStats {
  distanceM: number;
  ascentM: number | null;
  movingS: number | null;
  elapsedS: number;
}

export interface EntryPageData {
  id: string;
  slug: string;
  title: string;
  notes: string | null;
  occurredOn: string;
  authorHandle: string;
  authorDisplayName: string;
  stats: EntryStats;
  trackGeojson: GeoJSON.LineString;
  elevation: ElevationPoint[];
  photos: EntryPhoto[];
}

// The elevation profile is drawn against an 800px-wide SVG; a few hundred
// points is already more resolution than that can show, and the source track
// on one seeded activity has 15,047. Downsampling here (rather than in the
// component) keeps the payload the page ships small regardless of how dense
// the source track is.
const ELEVATION_TARGET_POINTS = 300;

interface EntryRow {
  id: string;
  slug: string;
  title: string;
  notes: string | null;
  occurred_on: string;
  handle: string;
  display_name: string;
  activity_id: string;
  distance_m: number;
  ascent_m: number | null;
  moving_s: number | null;
  elapsed_s: number;
  track_geojson: string;
}

// occurred_on::text: node-postgres parses a bare \`date\` column into a JS
// Date object (midnight UTC), not the "YYYY-MM-DD" string the EntryRow type
// says it is - formatOccurredOn's template-literal date parsing produced
// "Invalid Date" against that Date's default toString(). Casting in SQL
// keeps the value a plain string all the way to the page.
const ENTRY_COLUMNS = `
  e.id, e.slug, e.title, e.notes, e.occurred_on::text as occurred_on,
  p.handle, p.display_name,
  a.id as activity_id, a.distance_m, a.ascent_m, a.moving_s, a.elapsed_s,
  st_asgeojson(a.track_simplified) as track_geojson
`;

async function selectPublicEntry(
  client: PoolClient,
  handle: string,
  slug: string,
): Promise<EntryRow | null> {
  const { rows } = await client.query<EntryRow>(
    `select ${ENTRY_COLUMNS}
     from visible_entries e
     join public_profiles p on p.id = e.user_id
     join activities a on a.id = e.activity_id
     where p.handle = $1 and e.slug = $2`,
    [handle, slug],
  );
  return rows[0] ?? null;
}

// Reached only when the public lookup above misses. A private or unpublished
// entry still has a slug once it has ever been published (the
// published_entries_have_a_slug constraint), so an owner can still be looking
// at their own unlisted work here - everyone else genuinely gets nothing back,
// which is what turns into the 404 the page renders for a miss.
async function selectOwnEntry(
  client: PoolClient,
  handle: string,
  slug: string,
  viewerId: string,
): Promise<EntryRow | null> {
  const { rows } = await client.query<EntryRow>(
    `select ${ENTRY_COLUMNS}
     from entries e
     join public_profiles p on p.id = e.user_id
     join activities a on a.id = e.activity_id
     where p.handle = $1 and e.slug = $2 and e.user_id = $3`,
    [handle, slug, viewerId],
  );
  return rows[0] ?? null;
}

interface ElevationDumpRow {
  ele: number | null;
  dist_m: number;
}

async function loadElevationSeries(client: PoolClient, activityId: string): Promise<ElevationPoint[]> {
  const { rows } = await client.query<ElevationDumpRow>(
    `select
       st_z(pt.geom) as ele,
       st_linelocatepoint(st_force2d(a.track), pt.geom) * a.distance_m as dist_m
     from activities a,
          lateral st_dumppoints(a.track) as pt(path, geom)
     where a.id = $1
     order by (pt.path)[1]`,
    [activityId],
  );

  const withElevation = rows.filter((row): row is { ele: number; dist_m: number } => row.ele != null);
  return downsample(withElevation, ELEVATION_TARGET_POINTS).map((row) => ({
    distanceM: row.dist_m,
    elevationM: row.ele,
  }));
}

function downsample<T>(points: T[], target: number): T[] {
  if (points.length <= target) return points;
  const stride = points.length / target;
  const sampled: T[] = [];
  for (let i = 0; i < target; i += 1) {
    sampled.push(points[Math.floor(i * stride)]!);
  }
  const last = points[points.length - 1]!;
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

interface PhotoRow {
  id: string;
  captured_at: string | null;
  width: number | null;
  height: number | null;
  blur_hash: string | null;
  exif: { lens?: string; focalLength?: number; aperture?: number; iso?: number } | null;
  key_web: string | null;
  key_thumb: string | null;
  key_full: string | null;
  confidence: Confidence | null;
  elevation_m: number | null;
  distance_along_m: number | null;
  lon: number | null;
  lat: number | null;
}

async function loadPhotos(client: PoolClient, entryId: string): Promise<EntryPhoto[]> {
  const { rows } = await client.query<PhotoRow>(
    `select
       ph.id, ph.captured_at, ph.width, ph.height, ph.blur_hash, ph.exif,
       ph.key_web, ph.key_thumb, ph.key_full,
       pl.confidence, pl.elevation_m, pl.distance_along_m,
       st_x(pl.geom::geometry) as lon, st_y(pl.geom::geometry) as lat
     from photos ph
     left join photo_locations pl on pl.photo_id = ph.id
     where ph.entry_id = $1 and ph.status = 'ready' and ph.hidden = false
     order by ph.captured_at asc nulls last, ph.sort_order asc nulls last, ph.created_at asc`,
    [entryId],
  );

  return rows.map((row) => ({
    id: row.id,
    capturedAt: row.captured_at,
    width: row.width,
    height: row.height,
    blurHash: row.blur_hash,
    lens: row.exif?.lens ?? null,
    focalLength: row.exif?.focalLength ?? null,
    aperture: row.exif?.aperture ?? null,
    iso: row.exif?.iso ?? null,
    hasWeb: row.key_web != null,
    hasThumb: row.key_thumb != null,
    hasFull: row.key_full != null,
    location:
      row.lon != null && row.lat != null && row.confidence != null
        ? {
            lon: row.lon,
            lat: row.lat,
            elevationM: row.elevation_m,
            distanceAlongM: row.distance_along_m,
            confidence: row.confidence,
          }
        : null,
  }));
}

export async function loadEntryPage(
  handle: string,
  slug: string,
  viewerId: string | null,
): Promise<EntryPageData | null> {
  return withUser(viewerId, async (client) => {
    const row =
      (await selectPublicEntry(client, handle, slug)) ??
      (viewerId ? await selectOwnEntry(client, handle, slug, viewerId) : null);
    if (!row) return null;

    const [elevation, photos] = await Promise.all([
      loadElevationSeries(client, row.activity_id),
      loadPhotos(client, row.id),
    ]);

    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      notes: row.notes,
      occurredOn: row.occurred_on,
      authorHandle: row.handle,
      authorDisplayName: row.display_name,
      stats: {
        distanceM: row.distance_m,
        ascentM: row.ascent_m,
        movingS: row.moving_s,
        elapsedS: row.elapsed_s,
      },
      trackGeojson: JSON.parse(row.track_geojson) as GeoJSON.LineString,
      elevation,
      photos,
    };
  });
}

export interface DiscoveryEntry {
  handle: string;
  slug: string;
  title: string;
  occurredOn: string;
  authorDisplayName: string;
  trailName: string | null;
  stats: EntryStats;
  likeCount: number;
  trackGeojson: GeoJSON.LineString;
  leadPhoto: { id: string; blurHash: string | null; width: number | null; height: number | null } | null;
}

interface DiscoveryEntryRow {
  handle: string;
  slug: string;
  title: string;
  occurred_on: string;
  display_name: string;
  trail_name: string | null;
  distance_m: number;
  ascent_m: number | null;
  moving_s: number | null;
  elapsed_s: number;
  like_count: string;
  track_geojson: string;
  lead_photo_id: string | null;
  lead_blur_hash: string | null;
  lead_width: number | null;
  lead_height: number | null;
}

function mapDiscoveryRow(row: DiscoveryEntryRow): DiscoveryEntry {
  return {
    handle: row.handle,
    slug: row.slug,
    title: row.title,
    occurredOn: row.occurred_on,
    authorDisplayName: row.display_name,
    trailName: row.trail_name,
    stats: {
      distanceM: row.distance_m,
      ascentM: row.ascent_m,
      movingS: row.moving_s,
      elapsedS: row.elapsed_s,
    },
    likeCount: Number(row.like_count),
    trackGeojson: JSON.parse(row.track_geojson) as GeoJSON.LineString,
    leadPhoto: row.lead_photo_id
      ? {
          id: row.lead_photo_id,
          blurHash: row.lead_blur_hash,
          width: row.lead_width,
          height: row.lead_height,
        }
      : null,
  };
}

// Every card on the discovery page needs the entry, its author, its trail
// (if matched), its statistics, a like count and a simplified track to draw
// as a thumbnail. All of that comes back in one query rather than one round
// trip per card - the like count is a scalar subquery rather than a
// denormalised column (see the design note in the discovery page itself for
// why), which is cheap at the page's own row limit but would need revisiting
// if that limit ever grew far past a couple dozen.
export async function loadDiscoveryEntries(limit: number): Promise<DiscoveryEntry[]> {
  return readPublic(async (client) => {
    const { rows } = await client.query<DiscoveryEntryRow>(
      `select
         p.handle, e.slug, e.title, e.occurred_on::text as occurred_on, p.display_name,
         t.name as trail_name,
         a.distance_m, a.ascent_m, a.moving_s, a.elapsed_s,
         (select count(*) from likes l where l.entry_id = e.id) as like_count,
         st_asgeojson(a.track_simplified) as track_geojson,
         e.lead_photo_id, lp.blur_hash as lead_blur_hash, lp.width as lead_width, lp.height as lead_height
       from visible_entries e
       join public_profiles p on p.id = e.user_id
       join activities a on a.id = e.activity_id
       left join trails t on t.id = e.trail_id
       left join photos lp on lp.id = e.lead_photo_id and lp.status = 'ready'
       order by e.published_at desc
       limit $1`,
      [limit],
    );

    return rows.map(mapDiscoveryRow);
  });
}

export interface ProfileHeader {
  handle: string;
  displayName: string;
  joinedAt: string;
}

export interface ProfilePage {
  header: ProfileHeader;
  outingsVisible: boolean;
  entries: DiscoveryEntry[];
}

interface ProfileHeaderRow {
  id: string;
  handle: string;
  display_name: string;
  created_at: string;
  outings_visible: boolean;
}

// The header is public_profiles data and always resolves regardless of
// viewer. Whether the outings list resolves is its own predicate, taking the
// viewer id as an input rather than a boolean the call site computed ("is
// this the owner?") - so the one place that predicate lives is this query,
// and a follower system extends it here (an additional `or exists (...)`)
// rather than at every place that renders a profile.
async function loadProfileHeader(
  client: PoolClient,
  handle: string,
  viewerId: string | null,
): Promise<ProfileHeaderRow | null> {
  const { rows } = await client.query<ProfileHeaderRow>(
    `select p.id, p.handle, p.display_name, p.created_at::text as created_at,
            (p.profile_visibility = 'public' or p.id = $2) as outings_visible
     from public_profiles p
     where p.handle = $1`,
    [handle, viewerId],
  );
  return rows[0] ?? null;
}

// Entries for a profile's outings list. Resolved the same way likes and
// comments resolve visibility elsewhere in this codebase: through
// visible_entries, or-ed with an ownership check against the viewer id,
// never a JS-side "if (isOwner)" branch choosing between two different
// queries.
async function loadProfileEntries(
  client: PoolClient,
  ownerId: string,
  viewerId: string | null,
): Promise<DiscoveryEntry[]> {
  // Row-level security means a plain `from entries` scan is already
  // filtered to the acting user's own rows before any WHERE clause of ours
  // runs (entries_own, 0003_rls.sql) - an EXISTS-against-visible_entries
  // predicate bolted onto that scan can only ever narrow it further, never
  // widen it back out to a stranger's public entries. visible_entries
  // itself is the one thing that reads across accounts (it is defined
  // without security_invoker for exactly that reason), so the public branch
  // has to come from there; the owner branch reads the RLS-scoped base
  // table directly. Unioning the two - rather than an `or e.user_id = $2`
  // clause on a single `from entries` - is what actually resolves "visible
  // to this viewer" instead of silently collapsing to "owned by this
  // viewer" for every non-owner.
  const { rows } = await client.query<DiscoveryEntryRow>(
    `with combined as (
       select * from visible_entries where user_id = $1
       union
       select * from entries where user_id = $1 and user_id = $2 and status = 'published'
     )
     select
       p.handle, c.slug, c.title, c.occurred_on::text as occurred_on, p.display_name,
       t.name as trail_name,
       a.distance_m, a.ascent_m, a.moving_s, a.elapsed_s,
       (select count(*) from likes l where l.entry_id = c.id) as like_count,
       st_asgeojson(a.track_simplified) as track_geojson,
       c.lead_photo_id, lp.blur_hash as lead_blur_hash, lp.width as lead_width, lp.height as lead_height
     from combined c
     join public_profiles p on p.id = c.user_id
     join activities a on a.id = c.activity_id
     left join trails t on t.id = c.trail_id
     left join photos lp on lp.id = c.lead_photo_id and lp.status = 'ready'
     order by c.published_at desc`,
    [ownerId, viewerId],
  );
  return rows.map(mapDiscoveryRow);
}

export async function loadProfilePage(handle: string, viewerId: string | null): Promise<ProfilePage | null> {
  return withUser(viewerId, async (client) => {
    const header = await loadProfileHeader(client, handle, viewerId);
    if (!header) return null;

    const entries = header.outings_visible
      ? await loadProfileEntries(client, header.id, viewerId)
      : [];

    return {
      header: {
        handle: header.handle,
        displayName: header.display_name,
        joinedAt: header.created_at,
      },
      outingsVisible: header.outings_visible,
      entries,
    };
  });
}
