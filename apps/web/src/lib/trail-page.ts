import type { PoolClient } from "pg";
import { readPublic } from "./db";
import type { TrackGeometry } from "./track-geojson";
import type { EntryStats } from "./entries";

export type TrailNameSource = "activity" | "osm" | "user";

export interface TrailLeadPhoto {
  id: string;
  blurHash: string | null;
  width: number | null;
  height: number | null;
}

export interface TrailVisit {
  entrySlug: string;
  authorHandle: string;
  authorDisplayName: string;
  title: string;
  stats: EntryStats;
  leadPhoto: TrailLeadPhoto | null;
  trackGeojson: TrackGeometry;
}

export interface TrailVisitGroup {
  occurredOn: string;
  visits: TrailVisit[];
}

export interface TrailPageData {
  id: string;
  slug: string;
  name: string;
  nameSource: TrailNameSource;
  visitCount: number;
  monthsRepresented: number[];
  groups: TrailVisitGroup[];
}

interface TrailRow {
  id: string;
  slug: string;
  name: string;
  name_source: TrailNameSource;
}

async function selectTrail(client: PoolClient, slug: string): Promise<TrailRow | null> {
  const { rows } = await client.query<TrailRow>(
    `select id, slug, name, name_source from trails where slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

interface VisitRow {
  entry_slug: string;
  title: string;
  occurred_on: string;
  handle: string;
  display_name: string;
  distance_m: number;
  ascent_m: number | null;
  moving_s: number | null;
  elapsed_s: number;
  track_geojson: string;
  lead_photo_id: string | null;
  lead_blur_hash: string | null;
  lead_width: number | null;
  lead_height: number | null;
}

// Reads only through visible_entries, exactly like loadEntryPage's public
// lookup - a trail's visits are whatever that view exposes to an anonymous
// reader, so a private account's or an unpublished entry's activity on this
// same route contributes no row here at all.
async function selectTrailVisits(client: PoolClient, trailId: string): Promise<VisitRow[]> {
  const { rows } = await client.query<VisitRow>(
    `select
       e.slug as entry_slug, e.title, e.occurred_on::text as occurred_on,
       p.handle, p.display_name,
       a.distance_m, a.ascent_m, a.moving_s, a.elapsed_s,
       st_asgeojson(a.track_simplified) as track_geojson,
       e.lead_photo_id, lp.blur_hash as lead_blur_hash, lp.width as lead_width, lp.height as lead_height
     from visible_entries e
     join public_profiles p on p.id = e.user_id
     join visible_activities a on a.id = e.activity_id
     left join photos lp on lp.id = e.lead_photo_id and lp.status = 'ready'
     where e.trail_id = $1
     order by e.occurred_on desc, e.published_at desc`,
    [trailId],
  );
  return rows;
}

function groupByDate(rows: VisitRow[]): TrailVisitGroup[] {
  const groups: TrailVisitGroup[] = [];
  for (const row of rows) {
    const visit: TrailVisit = {
      entrySlug: row.entry_slug,
      authorHandle: row.handle,
      authorDisplayName: row.display_name,
      title: row.title,
      stats: {
        distanceM: row.distance_m,
        ascentM: row.ascent_m,
        movingS: row.moving_s,
        elapsedS: row.elapsed_s,
      },
      leadPhoto: row.lead_photo_id
        ? {
            id: row.lead_photo_id,
            blurHash: row.lead_blur_hash,
            width: row.lead_width,
            height: row.lead_height,
          }
        : null,
      trackGeojson: JSON.parse(row.track_geojson) as TrackGeometry,
    };

    const current = groups[groups.length - 1];
    if (current && current.occurredOn === row.occurred_on) {
      current.visits.push(visit);
    } else {
      groups.push({ occurredOn: row.occurred_on, visits: [visit] });
    }
  }
  return groups;
}

// The season strip's whole premise is legibility across a trail's calendar,
// not a single year's - two visits three years apart in the same October
// belong to the same dot. Only the month ordinal survives the read.
function monthsFrom(rows: VisitRow[]): number[] {
  const months = new Set<number>();
  for (const row of rows) {
    months.add(Number(row.occurred_on.slice(5, 7)));
  }
  return [...months].sort((a, b) => a - b);
}

export async function loadTrailPage(slug: string): Promise<TrailPageData | null> {
  return readPublic(async (client) => {
    const trail = await selectTrail(client, slug);
    if (!trail) return null;

    const rows = await selectTrailVisits(client, trail.id);

    return {
      id: trail.id,
      slug: trail.slug,
      name: trail.name,
      nameSource: trail.name_source,
      visitCount: rows.length,
      monthsRepresented: monthsFrom(rows),
      groups: groupByDate(rows),
    };
  });
}
