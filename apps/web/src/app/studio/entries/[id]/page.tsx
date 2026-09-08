import Link from "next/link";
import { notFound } from "next/navigation";
import { getViewerFromCookies } from "@/lib/auth";
import { withUser } from "@/lib/db";
import type { TrackGeometry } from "@/lib/track-geojson";
import { StudioShell } from "../../shell";
import { EntryEditor, type EditorPhoto } from "./entry-editor";

// Session-gated and per-request, for the same reason /studio is: this page
// renders one account's private state, and a shared cache entry here is the
// most direct privacy bug available.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edit outing",
  robots: { index: false, follow: false },
};

interface EntryRow {
  id: string;
  title: string;
  notes: string | null;
  slug: string | null;
  status: "draft" | "published";
  visibility: "public" | "private";
  comments_open: boolean;
  lead_photo_id: string | null;
  activity_id: string;
  occurred_on: string;
  handle: string;
}

interface PhotoRow {
  id: string;
  hidden: boolean;
  sort_order: number | null;
  width: number | null;
  height: number | null;
  blur_hash: string | null;
  status: string;
  key_thumb: string | null;
  captured_at: string | null;
  method: string | null;
  confidence: string | null;
  lon: number | null;
  lat: number | null;
}

export default async function StudioEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await getViewerFromCookies();

  if (!userId) {
    return (
      <StudioShell current="/studio/entries">
        <p className="mt-8 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          <Link href="/studio" className="underline underline-offset-4">
            Sign in
          </Link>{" "}
          to edit your outings.
        </p>
      </StudioShell>
    );
  }

  const data = await withUser(userId, async (client) => {
    const { rows: entryRows } = await client.query<EntryRow>(
      `select e.id, e.title, e.notes, e.slug, e.status, e.visibility, e.comments_open,
              e.lead_photo_id, e.activity_id, e.occurred_on::text as occurred_on, u.handle
       from entries e
       join users u on u.id = e.user_id
       where e.id = $1`,
      [id],
    );
    const entry = entryRows[0] ?? null;
    if (!entry) return null;

    const [{ rows: photoRows }, { rows: trackRows }] = await Promise.all([
      client.query<PhotoRow>(
        `select ph.id, ph.hidden, ph.sort_order, ph.width, ph.height, ph.blur_hash,
                ph.status, ph.key_thumb, ph.captured_at,
                pl.method, pl.confidence,
                st_x(pl.geom::geometry) as lon, st_y(pl.geom::geometry) as lat
         from photos ph
         left join photo_locations pl on pl.photo_id = ph.id
         where ph.entry_id = $1
         order by ph.sort_order asc nulls last, ph.captured_at asc nulls last, ph.created_at asc`,
        [entry.id],
      ),
      client.query<{ track_geojson: string | null }>(
        "select st_asgeojson(track_simplified) as track_geojson from activities where id = $1",
        [entry.activity_id],
      ),
    ]);

    return { entry, photoRows, trackGeojson: trackRows[0]?.track_geojson ?? null };
  });

  if (!data) {
    notFound();
  }

  const { entry, photoRows, trackGeojson } = data;

  const photos: EditorPhoto[] = photoRows.map((row) => ({
    id: row.id,
    hidden: row.hidden,
    sortOrder: row.sort_order,
    width: row.width,
    height: row.height,
    blurHash: row.blur_hash,
    capturedAt: row.captured_at,
    method: row.method,
    confidence: row.confidence,
    position: row.lon != null && row.lat != null ? { lon: row.lon, lat: row.lat } : null,
  }));

  return (
    <StudioShell current="/studio/entries">
      <div className="mt-4">
        <Link
          href="/studio/entries"
          className="text-sm text-zinc-500 underline underline-offset-4 dark:text-zinc-400"
        >
          Outings
        </Link>
      </div>
      <EntryEditor
        entry={{
          id: entry.id,
          title: entry.title,
          notes: entry.notes,
          slug: entry.slug,
          status: entry.status,
          visibility: entry.visibility,
          commentsOpen: entry.comments_open,
          leadPhotoId: entry.lead_photo_id,
          handle: entry.handle,
        }}
        photos={photos}
        trackGeojson={trackGeojson ? (JSON.parse(trackGeojson) as TrackGeometry) : null}
      />
    </StudioShell>
  );
}
